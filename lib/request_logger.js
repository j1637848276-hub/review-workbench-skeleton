'use strict'

/**
 * Structured JSON logging with a per-request id, no logging dependency.
 *
 * Every request gets an 8-byte id. It is attached to `req.id`, echoed in the
 * `X-Request-Id` response header, included in the error envelope the client
 * receives, and stamped on every log line emitted while that request is in
 * flight — including lines from deep inside services, which never receive the
 * request object. That last part is what AsyncLocalStorage buys: a service can
 * call `logger.info()` and the line still carries the right `reqId`.
 *
 * Why hand-rolled JSON lines instead of pino/winston:
 *  - zero runtime dependency
 *  - one event = one line, so `grep`, `jq`, Loki and Vector all just work
 *  - warn/error go to stderr, so `2>` splits the stream that pages someone
 *
 * Swap in pino if you outgrow it; keep the `reqId` field name so dashboards
 * built against this survive the change.
 */

const crypto = require('node:crypto')
const { AsyncLocalStorage } = require('node:async_hooks')

const requestContext = new AsyncLocalStorage()

const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50 })
const MIN_LEVEL = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info

/** Header and body keys that must never reach a log line. */
const REDACTED_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'authorization',
  'cookie',
  'jwtSecret',
  'apiKey',
  'secret',
])

function shouldLog(level) {
  return (LEVELS[level] ?? 0) >= MIN_LEVEL
}

function newRequestId() {
  return crypto.randomBytes(8).toString('hex')
}

function serializeError(error) {
  if (!(error instanceof Error)) return error
  return {
    message: error.message,
    name: error.name,
    code: error.code,
    stack: error.stack,
    ...(error.cause ? { cause: String(error.cause?.message || error.cause) } : {}),
  }
}

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  const output = {}
  for (const [key, inner] of Object.entries(value)) {
    output[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(inner, depth + 1)
  }
  return output
}

function writeLine(level, fields) {
  if (!shouldLog(level)) return
  const ctx = requestContext.getStore()
  const payload = { ...fields }
  if (payload.err !== undefined) payload.err = serializeError(payload.err)

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    lvl: level,
    ...(ctx?.reqId ? { reqId: ctx.reqId } : {}),
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
    ...redact(payload),
  })

  if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

const logger = Object.freeze({
  trace: (msg, fields = {}) => writeLine('trace', { msg, ...fields }),
  debug: (msg, fields = {}) => writeLine('debug', { msg, ...fields }),
  info: (msg, fields = {}) => writeLine('info', { msg, ...fields }),
  warn: (msg, fields = {}) => writeLine('warn', { msg, ...fields }),
  error: (msg, fields = {}) => writeLine('error', { msg, ...fields }),
})

/** The active request's context, or null outside a request. */
function currentContext() {
  return requestContext.getStore() || null
}

/**
 * Lets an authenticated route attach the user to every subsequent log line of
 * that request. Called by the auth middleware once the token is verified.
 */
function attachUserToContext(userId) {
  const ctx = requestContext.getStore()
  if (ctx) ctx.userId = userId
}

function createRequestLogger({ ignorePaths = ['/healthz', '/readyz'] } = {}) {
  const ignored = new Set(ignorePaths)

  return function requestLoggerMiddleware(req, res, next) {
    // Honour an upstream id so a trace survives the reverse proxy hop.
    const reqId = String(req.headers['x-request-id'] || '').slice(0, 64) || newRequestId()
    req.id = reqId
    res.setHeader('X-Request-Id', reqId)

    requestContext.run({ reqId }, () => {
      if (ignored.has(req.path)) return next()

      const startedAt = process.hrtime.bigint()
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
        writeLine(level, {
          msg: 'request',
          method: req.method,
          route: req.path,
          status: res.statusCode,
          ms: Math.round(ms),
        })
      })
      next()
    })
  }
}

module.exports = {
  createRequestLogger,
  logger,
  currentContext,
  attachUserToContext,
  newRequestId,
}
