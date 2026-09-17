'use strict'

/**
 * The single error exit for the API.
 *
 * Mount it *after every route*. Express picks error handlers in registration
 * order, so a handler mounted before a route can never see that route's
 * errors — a real trap when routes are registered from several modules. If you
 * add a late-mounted route module, either mount it before this middleware or
 * mount a second copy after it.
 *
 * The response envelope is fixed and worth keeping stable, because the SPA's
 * axios interceptor and every support conversation depend on it:
 *
 *   { "error": "human readable", "code": "machine_readable", "requestId": "…" }
 *
 * `requestId` is the reason an operator screenshot is actionable: it maps to
 * exactly one log line.
 */

const multer = require('multer')

const { AppError } = require('./errors')
const { logger } = require('./request_logger')

function sendError(res, status, body) {
  if (res.headersSent) return
  res.status(status).json(body)
}

function createApiErrorMiddleware({ uploadMaxFileSizeMb = 25, maxFilesPerRequest = 500 } = {}) {
  return function apiErrorHandler(error, req, res, next) {
    if (!error) return next()
    if (res.headersSent) return next(error)

    const requestId = req.id

    // Multer rejects before any handler runs, so these never reach a service
    // and would otherwise surface as an opaque 500 on a plainly fixable
    // operator mistake ("I selected the whole folder").
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_COUNT') {
        return sendError(res, 400, {
          error: `At most ${maxFilesPerRequest} files per upload. Split the batch and retry.`,
          code: 'upload_file_count_exceeded',
          requestId,
        })
      }
      if (error.code === 'LIMIT_FILE_SIZE') {
        return sendError(res, 400, {
          error: `Each file must be under ${uploadMaxFileSizeMb} MB.`,
          code: 'upload_file_size_exceeded',
          requestId,
        })
      }
      return sendError(res, 400, {
        error: 'Upload rejected.',
        code: `upload_${String(error.code || 'failed').toLowerCase()}`,
        requestId,
      })
    }

    // A deliberate outcome with a declared contract. Log at warn, not error:
    // a 404 is not an incident, and treating it as one trains people to ignore
    // the error stream.
    if (error instanceof AppError) {
      logger.warn('app_error', {
        route: req.path,
        method: req.method,
        status: error.status,
        code: error.code,
        error: error.message,
      })
      return sendError(res, error.status, {
        error: error.message,
        code: error.code,
        requestId,
        ...(error.details !== undefined ? { details: error.details } : {}),
      })
    }

    // Anything else is a bug. Log it whole, tell the client nothing: a stack
    // trace or driver message in a response body is an information leak.
    logger.error('unhandled_error', { err: error, route: req.path, method: req.method })
    return sendError(res, 500, {
      error: 'Internal error',
      code: 'internal_error',
      requestId,
    })
  }
}

module.exports = { createApiErrorMiddleware }
