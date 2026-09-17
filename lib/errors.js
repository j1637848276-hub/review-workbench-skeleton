'use strict'

/**
 * One error type per HTTP outcome the API is allowed to produce.
 *
 * Throw these from services and repositories. The error middleware turns an
 * `AppError` into its declared status and machine code; anything else becomes
 * a logged 500 with no detail leaked to the client. That split is the whole
 * design: an error either has a deliberate contract, or it is a bug.
 */

class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details, cause } = {}) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
    if (cause !== undefined) this.cause = cause
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Bad request', options = {}) {
    super(message, { status: 400, code: 'bad_request', ...options })
    this.name = 'BadRequestError'
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', options = {}) {
    super(message, { status: 401, code: 'unauthorized', ...options })
    this.name = 'UnauthorizedError'
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', options = {}) {
    super(message, { status: 403, code: 'forbidden', ...options })
    this.name = 'ForbiddenError'
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found', options = {}) {
    super(message, { status: 404, code: 'not_found', ...options })
    this.name = 'NotFoundError'
  }
}

/**
 * Use for "the state moved under you": a locked period, a batch someone else
 * already settled, a stage that is already running. Distinct from 400 because
 * the request was well-formed — retrying after a refresh may well succeed.
 */
class ConflictError extends AppError {
  constructor(message = 'Conflict', options = {}) {
    super(message, { status: 409, code: 'conflict', ...options })
    this.name = 'ConflictError'
  }
}

/** A downstream we do not control failed: model service, object store, SMTP. */
class UpstreamError extends AppError {
  constructor(message = 'Upstream service failed', options = {}) {
    super(message, { status: 502, code: 'upstream_failed', ...options })
    this.name = 'UpstreamError'
  }
}

module.exports = {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  UpstreamError,
}
