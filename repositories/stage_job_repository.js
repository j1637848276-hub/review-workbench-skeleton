'use strict'

/**
 * `stage_job` — the row the SPA polls while a background stage runs.
 *
 * Kept small and boring on purpose: the stage runner owns the lifecycle, this
 * owns the SQL. The only subtlety is `findByIdempotencyKey`, which is what
 * turns a double-clicked "Export" button into one export.
 */

function toJob(row) {
  if (!row) return null
  return {
    id: row.id,
    batchId: row.batch_id,
    stage: row.stage,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    progress: row.progress,
    total: row.total,
    // Pre-computed so three different UI surfaces do not each divide by zero
    // on a job whose total is not known yet.
    percent: row.total > 0 ? Math.round((row.progress / row.total) * 100) : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at,
    isTerminal: ['succeeded', 'failed', 'cancelled'].includes(row.status),
  }
}

function createStageJobRepository({ db }) {
  if (!db) throw new Error('db is required')

  const statements = {
    byId: db.prepare('SELECT * FROM stage_job WHERE id = ?'),
    byKey: db.prepare(`
      SELECT * FROM stage_job
       WHERE batch_id = ? AND stage = ? AND idempotency_key = ?
       ORDER BY id DESC LIMIT 1
    `),
    insert: db.prepare(`
      INSERT INTO stage_job (batch_id, stage, status, idempotency_key, triggered_by, created_at)
      VALUES (?, ?, 'queued', ?, ?, ?)
    `),
    markRunning: db.prepare("UPDATE stage_job SET status = 'running', started_at = ? WHERE id = ?"),
    updateProgress: db.prepare('UPDATE stage_job SET progress = ?, total = ? WHERE id = ?'),
    markSucceeded: db.prepare(
      "UPDATE stage_job SET status = 'succeeded', finished_at = ? WHERE id = ?"
    ),
    markFailed: db.prepare(`
      UPDATE stage_job SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?
    `),
    listByBatch: db.prepare(
      'SELECT * FROM stage_job WHERE batch_id = ? ORDER BY created_at DESC LIMIT ?'
    ),
    latestForStage: db.prepare(`
      SELECT * FROM stage_job WHERE batch_id = ? AND stage = ? ORDER BY id DESC LIMIT 1
    `),
  }

  function findById(id) {
    return toJob(statements.byId.get(Number(id)))
  }

  function findByIdempotencyKey({ batchId, stage, idempotencyKey }) {
    if (!idempotencyKey) return null
    return toJob(statements.byKey.get(String(batchId), String(stage), String(idempotencyKey)))
  }

  function create({ batchId, stage, idempotencyKey = null, userId = null }) {
    const { lastInsertRowid } = statements.insert.run(
      String(batchId),
      String(stage),
      idempotencyKey,
      userId,
      new Date().toISOString()
    )
    return findById(lastInsertRowid)
  }

  function markRunning(id) {
    statements.markRunning.run(new Date().toISOString(), Number(id))
  }

  function updateProgress(id, progress, total) {
    statements.updateProgress.run(Number(progress) || 0, Number(total) || 0, Number(id))
  }

  function markSucceeded(id) {
    statements.markSucceeded.run(new Date().toISOString(), Number(id))
  }

  function markFailed(id, message) {
    // Truncated: an upstream stack trace can be enormous, and this string is
    // rendered verbatim in an operator-facing toast.
    statements.markFailed.run(
      new Date().toISOString(),
      String(message ?? 'unknown error').slice(0, 1000),
      Number(id)
    )
  }

  function listByBatch(batchId, limit = 20) {
    return statements.listByBatch
      .all(String(batchId), Math.min(Number(limit) || 20, 100))
      .map(toJob)
  }

  function latestForStage(batchId, stage) {
    return toJob(statements.latestForStage.get(String(batchId), String(stage)))
  }

  return {
    findById,
    findByIdempotencyKey,
    create,
    markRunning,
    updateProgress,
    markSucceeded,
    markFailed,
    listByBatch,
    latestForStage,
  }
}

module.exports = { createStageJobRepository }
