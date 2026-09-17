'use strict'

/**
 * Builds the Express app. Returns it without listening, so a test can mount it
 * on an ephemeral port and a future worker process can reuse the same app.
 *
 * Middleware order is the load-bearing part of this file, and every position
 * is deliberate:
 *
 *   1. request logger      — so every later line carries a request id
 *   2. security headers     — before anything can produce a response
 *   3. health routes        — unauthenticated, so probes work while the rest
 *                             of the app is broken or still warming up
 *   4. body + cookie parse
 *   5. audit middleware     — after auth populates req.user, before routes
 *   6. routes
 *   7. SPA static + fallback — last, so it cannot shadow an /api route
 *   8. error handler        — after every route, or it sees nothing
 *
 * Moving 3 below 4 means a malformed body can break a health check. Moving 7
 * above 6 means a file named `api` in the SPA build shadows the API. Both have
 * happened to someone.
 */

const path = require('node:path')

const cookieParser = require('cookie-parser')
const express = require('express')

const { createApiErrorMiddleware } = require('../lib/api_error_middleware')
const { createAuditMiddleware } = require('../lib/audit_middleware')
const { createHealthRoutes } = require('../lib/health_routes')
const { createRequestLogger } = require('../lib/request_logger')
const { authenticateToken, requireRole } = require('../lib/auth/jwt_middleware')
const { publicConfigSummary } = require('../lib/config')

const { registerAdminRoutes } = require('../routes/admin_routes')
const { registerAuthRoutes } = require('../routes/auth_routes')
const { registerBatchRoutes } = require('../routes/batch_routes')
const { registerDocumentRoutes } = require('../routes/document_routes')

/**
 * Regenerated on every process start, sent on every response as `X-App-Boot`.
 *
 * This solves a real and easily-missed problem: an operator workbench is a SPA
 * that stays open for days. After a deploy, that tab keeps running the old
 * bundle — so a bug you fixed this morning keeps getting reported, and you
 * cannot reproduce it. The SPA compares this header across responses and shows
 * a "reload to update" banner when it changes. See
 * frontend/src/api/client.js for the other half.
 */
const APP_BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function createApp({ container, upload, frontendDistDir = null }) {
  const { config, repositories, services, stageRunner, healthProbes } = container
  const app = express()

  // Express sees the proxy's address otherwise, which makes the rate limiter
  // count every user as one client and makes audit-log IPs useless.
  app.set('trust proxy', Boolean(process.env.TRUST_PROXY))
  app.disable('x-powered-by')

  // ---- 1. request id + structured access log
  app.use(createRequestLogger())

  // ---- 2. security headers
  // Hand-rolled rather than pulling in helmet: five headers, no dependency,
  // and you can see exactly what is set. Swap in helmet if you want its
  // defaults maintained for you.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    // No Content-Security-Policy here. A useful CSP depends on how you serve
    // the SPA (nonce per request, or hashes of the built assets), so a generic
    // one would either break the app or be theatre. Add it at your reverse
    // proxy, or generate a nonce here once your build is settled.
    res.setHeader('X-App-Boot', APP_BOOT_ID)
    next()
  })

  // ---- 3. health, before auth and before body parsing
  createHealthRoutes({
    probes: healthProbes,
    meta: { boot: APP_BOOT_ID, ...publicConfigSummary(config) },
  }).register(app)

  // ---- 4. parsers
  // A modest JSON limit on purpose: nothing here posts a large body (files go
  // through multipart), so a generous limit only buys a cheap memory attack.
  app.use(express.json({ limit: config.server.jsonLimit }))
  app.use(cookieParser())

  // Auth is a middleware factory, not a global: most routes need it, health
  // must not have it, and login cannot have it.
  const authenticate = config.auth.enabled
    ? authenticateToken({ secret: config.auth.jwtSecret, userService: services.auth })
    : // Dev escape hatch. `loadConfig` refuses to start with auth disabled in
      // production, which is what keeps this from shipping.
      //
      // id is null, not 0. Every `created_by` / `reviewed_by` / `triggered_by`
      // column is a foreign key to user(id), and there is no user row for a
      // fabricated id — so id: 0 makes the first write fail with
      // "FOREIGN KEY constraint failed". null is what those nullable columns
      // are for.
      (req, _res, next) => {
        req.user = { id: null, username: 'dev', role: 'admin' }
        next()
      }

  // ---- 5. audit, after req.user exists and before the routes it records
  app.use(createAuditMiddleware({ auditLogRepository: repositories.auditLog }))

  // ---- 6. routes
  registerAuthRoutes({ app, authService: services.auth, config, authenticate })
  registerBatchRoutes({
    app,
    upload,
    authenticate,
    requireRole,
    batchRepository: repositories.batches,
    documentRepository: repositories.documents,
    stageJobRepository: repositories.stageJobs,
    documentIntakeService: services.intake,
    recognitionStageService: services.recognitionStage,
    exportService: services.export,
    stageRunner,
    config,
  })
  registerDocumentRoutes({
    app,
    authenticate,
    requireRole,
    documentRepository: repositories.documents,
    reviewService: services.review,
    documentIntakeService: services.intake,
  })
  registerAdminRoutes({
    app,
    authenticate,
    requireRole,
    authService: services.auth,
    userRepository: repositories.users,
    auditLogRepository: repositories.auditLog,
  })

  // Unknown API path: a JSON 404, not the SPA's index.html. Returning HTML
  // from a mistyped endpoint produces "Unexpected token < in JSON" — the least
  // informative error in web development.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Unknown endpoint', code: 'unknown_endpoint', requestId: req.id })
  })

  // ---- 7. SPA, last
  if (frontendDistDir) {
    app.use(express.static(frontendDistDir, { index: false, maxAge: '1h' }))
    app.get(/^(?!\/api).*/, (_req, res, next) => {
      // History-mode fallback: any non-API path renders the SPA, which then
      // routes client-side. `index.html` itself must never be cached, or a
      // deploy leaves browsers pointing at deleted asset hashes.
      res.setHeader('Cache-Control', 'no-store')
      res.sendFile(path.join(frontendDistDir, 'index.html'), (error) => {
        if (error) next()
      })
    })
  }

  // ---- 8. the single error exit
  app.use(
    createApiErrorMiddleware({
      uploadMaxFileSizeMb: config.uploads.maxFileSizeMb,
      maxFilesPerRequest: config.uploads.maxFilesPerRequest,
    })
  )

  return app
}

module.exports = { createApp, APP_BOOT_ID }
