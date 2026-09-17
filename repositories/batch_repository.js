'use strict'

/**
 * `batch` reads and writes, plus the lock check every write path depends on.
 *
 * `assertWritable` is the important method. A closed period must stay closed:
 * once a batch is locked, its numbers have been reported to someone, and a
 * late edit means the report and the database disagree with no record of why.
 * Call it at the top of every mutating service method rather than trusting the
 * UI to hide the button — the API is reachable without the UI.
 */

const { ConflictError, NotFoundError } = require('../lib/errors')

function toBatch(row) {
  if (!row) return null
  return {
    id: row.id,
    label: row.label,
    businessDay: row.business_day,
    status: row.status,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    isLocked: Boolean(row.locked_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    notes: row.notes,
    // Present only on the list query, which joins the counts.
    ...(row.document_count !== undefined ? { documentCount: row.document_count } : {}),
    ...(row.needs_review_count !== undefined ? { needsReviewCount: row.needs_review_count } : {}),
  }
}

function createBatchRepository({ db }) {
  if (!db) throw new Error('db is required')

  const statements = {
    byId: db.prepare('SELECT * FROM batch WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO batch (id, label, business_day, status, created_at, updated_at, created_by, notes)
      VALUES (?, ?, ?, 'open', ?, ?, ?, ?)
    `),
    setStatus: db.prepare('UPDATE batch SET status = ?, updated_at = ? WHERE id = ?'),
    lock: db.prepare('UPDATE batch SET locked_at = ?, locked_by = ?, updated_at = ? WHERE id = ?'),
    unlock: db.prepare(
      'UPDATE batch SET locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?'
    ),
    remove: db.prepare('DELETE FROM batch WHERE id = ?'),
    // One query with correlated counts rather than N+1 per row. At 200 batches
    // the difference is 1 query against 401.
    listWithCounts: db.prepare(`
      SELECT b.*,
             (SELECT COUNT(*) FROM document d WHERE d.batch_id = b.id) AS document_count,
             (SELECT COUNT(*) FROM document d WHERE d.batch_id = b.id AND d.status = 'needs_review')
               AS needs_review_count
        FROM batch b
       WHERE (? IS NULL OR b.status = ?)
         AND (? IS NULL OR b.business_day >= ?)
         AND (? IS NULL OR b.business_day <= ?)
       ORDER BY b.business_day DESC, b.created_at DESC
       LIMIT ? OFFSET ?
    `),
    count: db.prepare(`
      SELECT COUNT(*) AS total FROM batch
       WHERE (? IS NULL OR status = ?)
         AND (? IS NULL OR business_day >= ?)
         AND (? IS NULL OR business_day <= ?)
    `),
  }

  function findById(id) {
    return toBatch(statements.byId.get(String(id)))
  }

  /** Throws instead of returning null — the caller almost always wants that. */
  function requireById(id) {
    const batch = findById(id)
    if (!batch) throw new NotFoundError(`Batch "${id}" not found`)
    return batch
  }

  function assertWritable(id) {
    const batch = requireById(id)
    if (batch.isLocked) {
      throw new ConflictError(
        `Batch "${id}" is locked (since ${batch.lockedAt}). Unlock it before editing.`,
        { code: 'batch_locked', details: { lockedAt: batch.lockedAt, lockedBy: batch.lockedBy } }
      )
    }
    return batch
  }

  function create({ id, label, businessDay, createdBy = null, notes = null }) {
    const now = new Date().toISOString()
    try {
      statements.insert.run(
        String(id),
        String(label),
        String(businessDay),
        now,
        now,
        createdBy,
        notes
      )
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) {
        throw new ConflictError(`Batch "${id}" already exists`, { code: 'batch_exists' })
      }
      throw error
    }
    return findById(id)
  }

  function list({ status = null, from = null, to = null, limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200)
    const safeOffset = Math.max(Number(offset) || 0, 0)
    // Each filter is bound twice because SQLite has no named parameters here:
    // once for the NULL test, once for the comparison.
    const filters = [status, status, from, from, to, to]
    return {
      batches: statements.listWithCounts.all(...filters, safeLimit, safeOffset).map(toBatch),
      total: statements.count.get(...filters).total,
      limit: safeLimit,
      offset: safeOffset,
    }
  }

  function setStatus(id, status) {
    const { changes } = statements.setStatus.run(
      String(status),
      new Date().toISOString(),
      String(id)
    )
    if (changes === 0) throw new NotFoundError(`Batch "${id}" not found`)
    return findById(id)
  }

  function lock(id, userId) {
    assertWritable(id) // locking twice is a no-op worth reporting as a conflict
    const now = new Date().toISOString()
    statements.lock.run(now, userId ?? null, now, String(id))
    return findById(id)
  }

  function unlock(id) {
    requireById(id)
    statements.unlock.run(new Date().toISOString(), String(id))
    return findById(id)
  }

  /**
   * Removes the row; `ON DELETE CASCADE` takes the documents and fields with
   * it. Files on disk are *not* touched here — a repository must not do IO
   * outside the database, and orphaned files are recoverable while deleted
   * ones are not. The service decides what happens to storage.
   */
  function remove(id) {
    assertWritable(id)
    statements.remove.run(String(id))
  }

  return { findById, requireById, assertWritable, create, list, setStatus, lock, unlock, remove }
}

module.exports = { createBatchRepository }
