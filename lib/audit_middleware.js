'use strict'

/**
 * Writes an audit row for state-changing requests, driven by a route table.
 *
 * Why a table rather than an `audit()` call in each handler: the calls get
 * forgotten. A new export endpoint ships, and six months later nobody can
 * answer "who exported this". A table in one file is reviewable in one screen —
 * you can see at a glance which mutating routes are missing, and a
 * route-coverage test (see tests/audit_and_export.test.js) can assert that
 * every non-GET route is either listed or explicitly exempt.
 *
 * Only successful requests are recorded: a 400 changed nothing, and logging
 * failures here would bury the real entries under noise. Failed *logins* are
 * the exception — those are exactly what you need during an incident — so they
 * are matched on any status.
 *
 * Writes happen on `res.on('finish')`, after the response is sent, so audit
 * logging never adds latency and a logging failure cannot fail the operation.
 * The tradeoff is explicit: this is an audit trail, not a two-phase commit. If
 * you need "the write did not happen unless it was logged", move the insert
 * into the same transaction as the write itself.
 */

const { logger } = require('./request_logger')

/**
 * Add a row per mutating route. `pattern` is matched against `req.path`;
 * capture groups are mapped by `groups`.
 */
const DEFAULT_ACTION_MAP = Object.freeze([
  {
    method: 'POST',
    pattern: /^\/api\/auth\/login$/,
    action: 'login',
    resourceType: 'auth',
    onFailureToo: true, // the one route where failures matter most
  },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, action: 'logout', resourceType: 'auth' },

  {
    method: 'POST',
    pattern: /^\/api\/batches$/,
    action: 'create_batch',
    resourceType: 'batch',
    // The new id arrives in the body, not the path. Without this the entry
    // reads "someone created a batch" and cannot say which one, which is
    // exactly the question an audit trail exists to answer.
    resourceIdFrom: 'id',
  },
  {
    method: 'POST',
    pattern: /^\/api\/batches\/([^/]+)\/documents$/,
    action: 'upload_documents',
    resourceType: 'batch',
    groups: { resourceId: 1 },
  },
  {
    method: 'POST',
    pattern: /^\/api\/batches\/([^/]+)\/stages\/([^/]+)$/,
    action: 'run_stage',
    resourceType: 'stage_job',
    groups: { resourceId: 1 },
  },
  {
    method: 'POST',
    pattern: /^\/api\/batches\/([^/]+)\/lock$/,
    action: 'lock_batch',
    resourceType: 'batch',
    groups: { resourceId: 1 },
  },
  {
    method: 'POST',
    pattern: /^\/api\/batches\/([^/]+)\/unlock$/,
    action: 'unlock_batch',
    resourceType: 'batch',
    groups: { resourceId: 1 },
  },
  {
    method: 'POST',
    pattern: /^\/api\/batches\/([^/]+)\/export$/,
    action: 'export_batch',
    resourceType: 'batch',
    groups: { resourceId: 1 },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/batches\/([^/]+)$/,
    action: 'delete_batch',
    resourceType: 'batch',
    groups: { resourceId: 1 },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/documents\/([^/]+)\/fields$/,
    action: 'correct_fields',
    resourceType: 'document',
    groups: { resourceId: 1 },
  },
  {
    method: 'POST',
    pattern: /^\/api\/documents\/([^/]+)\/review$/,
    action: 'review_document',
    resourceType: 'document',
    groups: { resourceId: 1 },
  },

  { method: 'POST', pattern: /^\/api\/admin\/users$/, action: 'create_user', resourceType: 'user' },
  {
    method: 'PATCH',
    pattern: /^\/api\/admin\/users\/([^/]+)$/,
    action: 'update_user',
    resourceType: 'user',
    groups: { resourceId: 1 },
  },
])

function matchRoute(actionMap, req) {
  for (const entry of actionMap) {
    if (entry.method !== req.method) continue
    const match = entry.pattern.exec(req.path)
    if (match) return { entry, match }
  }
  return null
}

function createAuditMiddleware({ auditLogRepository, actionMap = DEFAULT_ACTION_MAP }) {
  if (!auditLogRepository) throw new Error('auditLogRepository is required')

  return function auditMiddleware(req, res, next) {
    const matched = matchRoute(actionMap, req)
    if (!matched) return next()

    const { entry, match } = matched

    // Snapshot anything needed from the body *now*. By the time `finish` fires
    // the handler may have mutated or consumed req.body, and on a streamed
    // upload it is gone entirely.
    const bodyResourceId = entry.resourceIdFrom ? (req.body?.[entry.resourceIdFrom] ?? null) : null
    const attemptedUsername = req.body?.username ?? null

    res.on('finish', () => {
      const succeeded = res.statusCode >= 200 && res.statusCode < 400
      if (!succeeded && !entry.onFailureToo) return

      const groups = entry.groups || {}
      try {
        auditLogRepository.append({
          occurredAt: new Date().toISOString(),
          userId: req.user?.id ?? null,
          // Denormalised so the entry still reads correctly after a rename.
          // On a failed login there is no req.user, so fall back to the
          // attempted username — that is the field an incident review needs.
          username: req.user?.username ?? attemptedUsername,
          action: entry.action,
          resourceType: entry.resourceType ?? null,
          resourceId: groups.resourceId
            ? (match[groups.resourceId] ?? null)
            : bodyResourceId !== null
              ? String(bodyResourceId)
              : null,
          statusCode: res.statusCode,
          requestId: req.id ?? null,
          ip: req.ip ?? null,
          // Path and query only. Never the body: it holds passwords on the
          // login route and document contents everywhere else.
          details: JSON.stringify({ path: req.originalUrl?.split('?')[0] ?? req.path }),
        })
      } catch (error) {
        logger.error('audit_write_failed', { err: error, action: entry.action, route: req.path })
      }
    })

    return next()
  }
}

module.exports = { createAuditMiddleware, DEFAULT_ACTION_MAP }
