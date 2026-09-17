'use strict'

/**
 * Document review endpoints.
 *
 *   GET    /api/documents/queue        worst-confidence-first review queue
 *   GET    /api/documents/:id          document + fields + change history
 *   GET    /api/documents/:id/file     the image itself, authenticated
 *   PATCH  /api/documents/:id/fields   apply corrections
 *   POST   /api/documents/:id/review   approve or reject
 */

const fs = require('node:fs')
const path = require('node:path')

const { NotFoundError } = require('../lib/errors')
const { asyncRoute } = require('./auth_routes')

const CONTENT_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
})

function registerDocumentRoutes({
  app,
  authenticate,
  requireRole,
  documentRepository,
  reviewService,
  documentIntakeService,
}) {
  app.get(
    '/api/documents/queue',
    authenticate,
    asyncRoute(async (req, res) => {
      res.json({
        documents: reviewService.listQueue({
          batchId: req.query.batchId ?? null,
          limit: req.query.limit,
        }),
      })
    })
  )

  app.get(
    '/api/documents/:id',
    authenticate,
    asyncRoute(async (req, res) => {
      res.json(reviewService.getDocumentDetail(req.params.id))
    })
  )

  /**
   * Serves the file through the app rather than as a static directory.
   *
   * `express.static` over the storage root would publish every document to
   * anyone who can guess a path — including documents from batches the user
   * has no business seeing. Going through a route means the auth middleware
   * and, when you add one, a per-batch access check both apply.
   */
  app.get(
    '/api/documents/:id/file',
    authenticate,
    asyncRoute(async (req, res) => {
      const document = documentRepository.requireById(req.params.id)
      const absolute = documentIntakeService.resolveStoragePath(document.storagePath)

      if (!fs.existsSync(absolute)) {
        throw new NotFoundError('Document file is missing from storage', { code: 'file_missing' })
      }

      const ext = path.extname(absolute).toLowerCase()
      // Explicit allow-list, never a sniffed type: serving an unexpected
      // content type from a user-supplied file is how a stored XSS happens.
      res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      // Private: these are business documents, and a shared proxy must not
      // keep a copy.
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.sendFile(absolute)
    })
  )

  app.patch(
    '/api/documents/:id/fields',
    authenticate,
    requireRole('reviewer'),
    asyncRoute(async (req, res) => {
      res.json(
        reviewService.applyCorrections({
          documentId: req.params.id,
          corrections: req.body?.corrections,
          userId: req.user.id,
          reason: req.body?.reason ?? null,
        })
      )
    })
  )

  app.post(
    '/api/documents/:id/review',
    authenticate,
    requireRole('reviewer'),
    asyncRoute(async (req, res) => {
      res.json(
        reviewService.review({
          documentId: req.params.id,
          decision: req.body?.decision,
          userId: req.user.id,
        })
      )
    })
  )
}

module.exports = { registerDocumentRoutes }
