'use strict'

/**
 * Append-only access to `audit_log`. There is deliberately no update or delete
 * method: an audit trail with an edit path is not an audit trail, and the
 * absence of the method is the cheapest enforcement available.
 *
 * Retention, when you need it, belongs in a scheduled job that copies whole
 * date ranges out to cold storage and then drops them — an operation a reviewer
 * can see in a diff, not a method any service can call.
 */

function toEntry(row) {
  if (!row) return null
  let details = null
  if (row.details) {
    try {
      details = JSON.parse(row.details)
    } catch {
      // Keep the raw text rather than dropping the entry: a malformed detail
      // blob is still evidence.
      details = { raw: row.details }
    }
  }
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    userId: row.user_id,
    username: row.username,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    statusCode: row.status_code,
    requestId: row.request_id,
    ip: row.ip,
    details,
  }
}

function createAuditLogRepository({ db }) {
  if (!db) throw new Error('db is required')

  const statements = {
    insert: db.prepare(`
      INSERT INTO audit_log
        (occurred_at, user_id, username, action, resource_type, resource_id,
         status_code, request_id, ip, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    distinctActions: db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action'),
  }

  function append(entry) {
    statements.insert.run(
      entry.occurredAt ?? new Date().toISOString(),
      entry.userId ?? null,
      entry.username ?? null,
      String(entry.action),
      entry.resourceType ?? null,
      entry.resourceId ?? null,
      entry.statusCode ?? null,
      entry.requestId ?? null,
      entry.ip ?? null,
      typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details ?? null)
    )
  }

  /**
   * Filtered, paginated read for the audit view.
   *
   * SQL is assembled from a fixed set of clauses with bound parameters —
   * never from interpolated values. The shape below is the pattern to copy for
   * every filtered list in the app: push a clause, push a parameter, keep them
   * in step.
   */
  function search({
    action = null,
    userId = null,
    resourceType = null,
    resourceId = null,
    from = null,
    to = null,
    limit = 50,
    offset = 0,
  } = {}) {
    const clauses = []
    const params = []

    if (action) {
      clauses.push('action = ?')
      params.push(String(action))
    }
    if (userId) {
      clauses.push('user_id = ?')
      params.push(Number(userId))
    }
    if (resourceType) {
      clauses.push('resource_type = ?')
      params.push(String(resourceType))
    }
    if (resourceId) {
      clauses.push('resource_id = ?')
      params.push(String(resourceId))
    }
    if (from) {
      clauses.push('occurred_at >= ?')
      params.push(String(from))
    }
    if (to) {
      clauses.push('occurred_at <= ?')
      params.push(String(to))
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    // Hard ceiling on the page size. Without it, `?limit=1000000` is a
    // one-request way to exhaust the server's memory.
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500)
    const safeOffset = Math.max(Number(offset) || 0, 0)

    const rows = db
      .prepare(
        `SELECT * FROM audit_log ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, safeLimit, safeOffset)
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM audit_log ${where}`).get(...params)

    return { entries: rows.map(toEntry), total, limit: safeLimit, offset: safeOffset }
  }

  /** Powers the filter dropdown without hardcoding the action list twice. */
  function listActions() {
    return statements.distinctActions.all().map((row) => row.action)
  }

  return { append, search, listActions }
}

module.exports = { createAuditLogRepository }
