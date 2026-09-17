'use strict'

/**
 * Config is read from the environment exactly once, at boot, and validated
 * here. Nothing else in the codebase touches `process.env`.
 *
 * Two rules make this worth the file:
 *
 *  1. Fail at boot, not at 02:00. A missing JWT_SECRET must kill the process
 *     on startup, where a deploy check catches it — not throw on the first
 *     login attempt hours later.
 *  2. One place to look. When an operator asks "what threshold is production
 *     actually running?", the answer is `GET /healthz` plus this file, not a
 *     grep for `process.env` across 200 modules.
 */

const path = require('node:path')

function str(name, fallback = '') {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : String(value)
}

function bool(name, fallback = false) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function int(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function float(name, fallback) {
  const parsed = Number.parseFloat(String(process.env[name] ?? ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function loadConfig({ projectRoot = process.cwd() } = {}) {
  const storageRoot = path.resolve(projectRoot, str('STORAGE_ROOT', './storage'))

  const config = Object.freeze({
    projectRoot,
    env: str('NODE_ENV', 'development'),

    server: Object.freeze({
      port: int('PORT', 3000),
      host: str('HOST', '127.0.0.1'),
      jsonLimit: str('JSON_BODY_LIMIT', '2mb'),
      // Long enough for a slow upload over an office uplink, short enough that
      // a wedged request eventually frees its socket.
      requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 5 * 60 * 1000),
      shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 15_000),
    }),

    logging: Object.freeze({
      level: str('LOG_LEVEL', 'info'),
    }),

    storage: Object.freeze({
      root: storageRoot,
      documentsRoot: path.join(storageRoot, 'documents'),
      exportsRoot: path.join(storageRoot, 'exports'),
      tmpUploadRoot: path.join(storageRoot, 'tmp_uploads'),
      databasePath: path.join(storageRoot, 'workbench.sqlite'),
    }),

    auth: Object.freeze({
      enabled: bool('AUTH_ENABLED', true),
      jwtSecret: str('JWT_SECRET'),
      jwtExpiresIn: str('JWT_EXPIRES_IN', '24h'),
      cookieSecure: bool('AUTH_COOKIE_SECURE', false),
      bootstrapAdminUsername: str('BOOTSTRAP_ADMIN_USERNAME', 'admin'),
      bootstrapAdminPassword: str('BOOTSTRAP_ADMIN_PASSWORD'),
      loginRateLimitMax: int('LOGIN_RATE_LIMIT_MAX', 5),
      loginRateLimitWindowMs: int('LOGIN_RATE_LIMIT_WINDOW_MS', 60_000),
    }),

    uploads: Object.freeze({
      maxFileSizeMb: int('UPLOAD_MAX_FILE_SIZE_MB', 25),
      maxFilesPerRequest: int('UPLOAD_MAX_FILES_PER_REQUEST', 500),
      // Extend for your own inputs. Anything not listed is dropped rather than
      // written to disk — see lib/uploads.js for why dropping beats erroring.
      allowedExtensions: Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.pdf']),
    }),

    recognition: Object.freeze({
      provider: str('RECOGNITION_PROVIDER', 'mock'),
      endpoint: str('RECOGNITION_ENDPOINT'),
      apiKey: str('RECOGNITION_API_KEY'),
      timeoutMs: int('RECOGNITION_TIMEOUT_MS', 30_000),
      concurrency: Math.max(1, int('RECOGNITION_CONCURRENCY', 2)),
      reviewThreshold: float('RECOGNITION_REVIEW_THRESHOLD', 0.85),
    }),
  })

  assertValid(config)
  return config
}

function assertValid(config) {
  const problems = []

  if (config.auth.enabled && !config.auth.jwtSecret) {
    problems.push(
      'JWT_SECRET is required when AUTH_ENABLED=true. Generate one with:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
    )
  }
  if (config.auth.enabled && config.auth.jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters.')
  }
  if (config.recognition.provider === 'http' && !config.recognition.endpoint) {
    problems.push('RECOGNITION_ENDPOINT is required when RECOGNITION_PROVIDER=http.')
  }
  if (config.recognition.reviewThreshold < 0 || config.recognition.reviewThreshold > 1) {
    problems.push('RECOGNITION_REVIEW_THRESHOLD must be between 0 and 1.')
  }
  if (!config.auth.enabled && config.env === 'production') {
    problems.push('AUTH_ENABLED=false in production would publish every route. Refusing to start.')
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
  }
}

/**
 * What /healthz is allowed to show. Never widen this to the whole config —
 * the health endpoint is deliberately unauthenticated.
 */
function publicConfigSummary(config) {
  return {
    env: config.env,
    authEnabled: config.auth.enabled,
    recognitionProvider: config.recognition.provider,
    reviewThreshold: config.recognition.reviewThreshold,
  }
}

module.exports = { loadConfig, publicConfigSummary }
