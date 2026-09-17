'use strict'

/**
 * `document`, `document_field` and `field_history`.
 *
 * These three tables move together — you never write a field without also
 * recomputing the document's review status, and never change a value without
 * recording who changed it — so they share a repository. Splitting them would
 * mean a service coordinating three repositories inside one transaction, which
 * is exactly the coupling a repository is supposed to hide.
 */

const { runInTransaction } = require('../lib/storage/sqlite_transaction')
const { NotFoundError } = require('../lib/errors')

function toDocument(row) {
  if (!row) return null
  return {
    id: row.id,
    batchId: row.batch_id,
    storagePath: row.storage_path,
    originalName: row.original_name,
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    docType: row.doc_type,
    status: row.status,
    minConfidence: row.min_confidence,
    pageNumber: row.page_number ?? 1,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toField(row) {
  if (!row) return null
  return {
    key: row.field_key,
    rawValue: row.raw_value,
    value: row.value,
    confidence: row.confidence,
    source: row.source,
    corrected: row.corrected === 1,
    bbox: row.bbox ? JSON.parse(row.bbox) : null,
  }
}

function createDocumentRepository({ db }) {
  if (!db) throw new Error('db is required')

  const statements = {
    byId: db.prepare('SELECT * FROM document WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO document
        (id, batch_id, storage_path, original_name, content_hash, byte_size,
         doc_type, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `),
    byBatch: db.prepare(`
      SELECT * FROM document
       WHERE batch_id = ?
         AND (? IS NULL OR status = ?)
       ORDER BY page_number, original_name
       LIMIT ? OFFSET ?
    `),
    countByBatch: db.prepare(
      'SELECT COUNT(*) AS total FROM document WHERE batch_id = ? AND (? IS NULL OR status = ?)'
    ),
    pendingByBatch: db.prepare("SELECT * FROM document WHERE batch_id = ? AND status = 'pending'"),
    existsByHash: db.prepare('SELECT id, batch_id FROM document WHERE content_hash = ? LIMIT 1'),
    setRecognized: db.prepare(`
      UPDATE document SET status = ?, doc_type = ?, min_confidence = ?, updated_at = ? WHERE id = ?
    `),
    setReviewed: db.prepare(`
      UPDATE document SET status = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?
    `),
    fieldsFor: db.prepare('SELECT * FROM document_field WHERE document_id = ? ORDER BY field_key'),
    upsertField: db.prepare(`
      INSERT INTO document_field
        (document_id, field_key, raw_value, value, confidence, source, corrected, bbox, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (document_id, field_key) DO UPDATE SET
        raw_value  = excluded.raw_value,
        value      = excluded.value,
        confidence = excluded.confidence,
        source     = excluded.source,
        corrected  = excluded.corrected,
        bbox       = excluded.bbox,
        updated_at = excluded.updated_at
    `),
    currentFieldValue: db.prepare(
      'SELECT value, raw_value FROM document_field WHERE document_id = ? AND field_key = ?'
    ),
    // Corrections update in place and must never touch raw_value — the
    // model's original output is the baseline every accuracy metric is
    // measured against.
    correctField: db.prepare(`
      UPDATE document_field
         SET value = ?, confidence = 1, source = 'human', corrected = 1, updated_at = ?
       WHERE document_id = ? AND field_key = ?
    `),
    insertCorrectedField: db.prepare(`
      INSERT INTO document_field
        (document_id, field_key, raw_value, value, confidence, source, corrected, bbox, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 1, 'human', 1, NULL, ?, ?)
    `),
    insertHistory: db.prepare(`
      INSERT INTO field_history (document_id, field_key, old_value, new_value, changed_by, changed_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    historyFor: db.prepare(
      'SELECT * FROM field_history WHERE document_id = ? ORDER BY changed_at DESC LIMIT ?'
    ),
    reviewQueue: db.prepare(`
      SELECT d.* FROM document d
       WHERE d.status = 'needs_review'
         AND (? IS NULL OR d.batch_id = ?)
       ORDER BY d.min_confidence ASC, d.created_at ASC
       LIMIT ?
    `),
  }

  function findById(id) {
    return toDocument(statements.byId.get(String(id)))
  }

  function requireById(id) {
    const document = findById(id)
    if (!document) throw new NotFoundError(`Document "${id}" not found`)
    return document
  }

  function create(document) {
    const now = new Date().toISOString()
    statements.insert.run(
      String(document.id),
      String(document.batchId),
      String(document.storagePath),
      String(document.originalName),
      document.contentHash ?? null,
      document.byteSize ?? null,
      document.docType ?? null,
      now,
      now
    )
    return findById(document.id)
  }

  /** One transaction for a whole upload: 300 individual commits would fsync 300 times. */
  function createMany(documents) {
    return runInTransaction(db, () => documents.map((document) => create(document)))
  }

  function findByContentHash(hash) {
    if (!hash) return null
    return statements.existsByHash.get(String(hash)) ?? null
  }

  function listByBatch(batchId, { status = null, limit = 200, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000)
    const safeOffset = Math.max(Number(offset) || 0, 0)
    return {
      documents: statements.byBatch
        .all(String(batchId), status, status, safeLimit, safeOffset)
        .map(toDocument),
      total: statements.countByBatch.get(String(batchId), status, status).total,
      limit: safeLimit,
      offset: safeOffset,
    }
  }

  function listPending(batchId) {
    return statements.pendingByBatch.all(String(batchId)).map(toDocument)
  }

  function getFields(documentId) {
    return statements.fieldsFor.all(String(documentId)).map(toField)
  }

  /**
   * Stores a recognition result and decides the document's next status.
   *
   * The threshold decision lives here rather than in the provider so that
   * re-tuning it is a config change, and so the same rule applies no matter
   * which provider produced the fields.
   */
  function saveRecognitionResult({ documentId, result, reviewThreshold }) {
    return runInTransaction(db, () => {
      const now = new Date().toISOString()
      let minConfidence = 1

      for (const field of result.fields) {
        minConfidence = Math.min(minConfidence, field.confidence)
        statements.upsertField.run(
          String(documentId),
          field.key,
          field.rawValue,
          field.rawValue, // normalisation happens in the service; raw is the seed
          field.confidence,
          'model',
          0,
          field.bbox ? JSON.stringify(field.bbox) : null,
          now,
          now
        )
      }

      // A document with no fields at all goes to review, not to approved — an
      // empty extraction is a failure, and defaulting minConfidence to 1 would
      // otherwise auto-approve it.
      const effectiveMin = result.fields.length === 0 ? 0 : minConfidence
      const status = effectiveMin >= reviewThreshold ? 'recognized' : 'needs_review'

      statements.setRecognized.run(
        status,
        result.docType ?? null,
        effectiveMin,
        now,
        String(documentId)
      )
      return { status, minConfidence: effectiveMin }
    })
  }

  /**
   * Applies human corrections. Every changed value writes a history row in the
   * same transaction, so the trail cannot drift from the data.
   */
  function applyCorrections({ documentId, corrections, userId, reason = null }) {
    return runInTransaction(db, () => {
      const now = new Date().toISOString()
      const changed = []

      for (const [fieldKey, newValue] of Object.entries(corrections)) {
        const current = statements.currentFieldValue.get(String(documentId), fieldKey)
        const oldValue = current?.value ?? null
        if (oldValue === newValue) continue // no-op edits must not pollute history

        // A human-entered value is certain by definition, hence confidence 1.
        // A field the model never emitted is inserted rather than updated —
        // operators do add values the extraction missed entirely.
        if (current) {
          statements.correctField.run(newValue, now, String(documentId), fieldKey)
        } else {
          statements.insertCorrectedField.run(String(documentId), fieldKey, newValue, now, now)
        }
        statements.insertHistory.run(
          String(documentId),
          fieldKey,
          oldValue,
          newValue,
          userId ?? null,
          now,
          reason
        )
        changed.push(fieldKey)
      }

      return { changed }
    })
  }

  function setReviewStatus({ documentId, status, userId }) {
    const now = new Date().toISOString()
    const { changes } = statements.setReviewed.run(
      status,
      userId ?? null,
      now,
      now,
      String(documentId)
    )
    if (changes === 0) throw new NotFoundError(`Document "${documentId}" not found`)
    return findById(documentId)
  }

  function getHistory(documentId, limit = 100) {
    return statements.historyFor.all(String(documentId), Math.min(Number(limit) || 100, 500))
  }

  /** Worst-confidence-first: the queue should hand out the riskiest work next. */
  function reviewQueue({ batchId = null, limit = 50 } = {}) {
    return statements.reviewQueue
      .all(batchId, batchId, Math.min(Number(limit) || 50, 200))
      .map(toDocument)
  }

  return {
    findById,
    requireById,
    create,
    createMany,
    findByContentHash,
    listByBatch,
    listPending,
    getFields,
    saveRecognitionResult,
    applyCorrections,
    setReviewStatus,
    getHistory,
    reviewQueue,
  }
}

module.exports = { createDocumentRepository }
