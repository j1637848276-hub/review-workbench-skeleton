'use strict'

/**
 * Batch lifecycle and the stages that run over a batch.
 *
 *   GET    /api/batches                       list, filtered and paged
 *   POST   /api/batches                       create
 *   GET    /api/batches/:id                   detail + document counts
 *   DELETE /api/batches/:id                   delete (blocked while locked)
 *   POST   /api/batches/:id/documents         upload files into the batch
 *   POST   /api/batches/:id/stages/recognize  start recognition, returns a job
 *   GET    /api/batches/:id/jobs              recent jobs
 *   GET    /api/batches/:id/jobs/:jobId       poll one job
 *   POST   /api/batches/:id/lock | /unlock    close or reopen the period
 *   POST   /api/batches/:id/export            start an export, returns a job
 *
 * Role gating is per route and deliberately explicit rather than a table
 * somewhere else: the permission is the most security-relevant fact about an
 * endpoint and belongs where you read the endpoint.
 */

const { BadRequestError } = require('../lib/errors')
const { asyncRoute } = require('./auth_routes')

const BUSINESS_DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function registerBatchRoutes({
  app,
  upload,
  authenticate,
  requireRole,
  batchRepository,
  documentRepository,
  stageJobRepository,
  documentIntakeService,
  recognitionStageService,
  exportService,
  stageRunner,
  config,
}) {
  app.get(
    '/api/batches',
    authenticate,
    asyncRoute(async (req, res) => {
      const { status = null, from = null, to = null, limit, offset } = req.query
      res.json(batchRepository.list({ status, from, to, limit, offset }))
    })
  )

  app.post(
    '/api/batches',
    authenticate,
    requireRole('reviewer'),
    asyncRoute(async (req, res) => {
      const { id, label, businessDay, notes = null } = req.body ?? {}

      // Validated here rather than trusted from the SPA: the id becomes a
      // directory name under STORAGE_ROOT, so anything outside this character
      // set is a path-traversal attempt waiting to happen.
      if (!BATCH_ID_RE.test(String(id ?? ''))) {
        throw new BadRequestError(
          'id must be 1-64 characters of letters, digits, dot, underscore or dash',
          { code: 'invalid_batch_id' }
        )
      }
      if (!label) throw new BadRequestError('label is required', { code: 'missing_label' })
      if (!BUSINESS_DAY_RE.test(String(businessDay ?? ''))) {
        throw new BadRequestError('businessDay must be YYYY-MM-DD', {
          code: 'invalid_business_day',
        })
      }

      res
        .status(201)
        .json(batchRepository.create({ id, label, businessDay, createdBy: req.user.id, notes }))
    })
  )

  app.get(
    '/api/batches/:id',
    authenticate,
    asyncRoute(async (req, res) => {
      const batch = batchRepository.requireById(req.params.id)
      res.json({
        batch,
        documents: documentRepository.listByBatch(req.params.id, {
          status: req.query.status ?? null,
          limit: req.query.limit,
          offset: req.query.offset,
        }),
        jobs: stageJobRepository.listByBatch(req.params.id, 10),
        exportPlans: exportService.listPlans(),
      })
    })
  )

  app.delete(
    '/api/batches/:id',
    authenticate,
    requireRole('admin'),
    asyncRoute(async (req, res) => {
      // Rows go via CASCADE; the files on disk are intentionally left behind.
      // Deleting a batch is recoverable this way, and an operator who deletes
      // the wrong one within the hour still has the images.
      batchRepository.remove(req.params.id)
      res.json({ ok: true, note: 'Database rows removed. Files remain under STORAGE_ROOT.' })
    })
  )

  app.post(
    '/api/batches/:id/documents',
    authenticate,
    requireRole('reviewer'),
    upload.array('files', config.uploads.maxFilesPerRequest),
    asyncRoute(async (req, res) => {
      const result = await documentIntakeService.ingest({
        batchId: req.params.id,
        files: req.files ?? [],
      })
      // Report all three counts. "Uploaded 300 files" when 40 were duplicates
      // and 2 unreadable is the kind of half-truth that costs a day of
      // reconciliation later.
      res.status(201).json({
        accepted: result.accepted.length,
        duplicates: result.duplicates,
        failed: result.failed,
      })
    })
  )

  app.post(
    '/api/batches/:id/stages/recognize',
    authenticate,
    requireRole('reviewer'),
    asyncRoute(async (req, res) => {
      const { jobId, reused } = recognitionStageService.start({
        batchId: req.params.id,
        userId: req.user.id,
        // Let the client supply a key so a retried request after a dropped
        // connection does not start a second run.
        idempotencyKey: req.get('Idempotency-Key') ?? req.body?.idempotencyKey ?? null,
      })
      res.status(reused ? 200 : 202).json({ jobId, reused })
    })
  )

  app.get(
    '/api/batches/:id/jobs',
    authenticate,
    asyncRoute(async (req, res) => {
      res.json({ jobs: stageJobRepository.listByBatch(req.params.id, req.query.limit ?? 20) })
    })
  )

  app.get(
    '/api/batches/:id/jobs/:jobId',
    authenticate,
    asyncRoute(async (req, res) => {
      // The SPA polls this. Explicitly uncacheable: a proxy serving a stale
      // "running" makes a finished job look hung forever.
      res.setHeader('Cache-Control', 'no-store')
      res.json(stageRunner.getJob(req.params.jobId))
    })
  )

  app.post(
    '/api/batches/:id/lock',
    authenticate,
    requireRole('reviewer'),
    asyncRoute(async (req, res) => {
      res.json(batchRepository.lock(req.params.id, req.user.id))
    })
  )

  app.post(
    '/api/batches/:id/unlock',
    authenticate,
    // Admin only, and on purpose: reopening a closed period is the one action
    // here that can change a number someone has already reported.
    requireRole([], { allowAdmin: true }),
    asyncRoute(async (req, res) => {
      res.json(batchRepository.unlock(req.params.id))
    })
  )

  app.post(
    '/api/batches/:id/export',
    authenticate,
    requireRole('reviewer'),
    asyncRoute(async (req, res) => {
      const { jobId, reused } = exportService.start({
        batchId: req.params.id,
        planId: req.body?.planId,
        userId: req.user.id,
        idempotencyKey: req.get('Idempotency-Key') ?? null,
      })
      res.status(reused ? 200 : 202).json({ jobId, reused })
    })
  )
}

module.exports = { registerBatchRoutes }
