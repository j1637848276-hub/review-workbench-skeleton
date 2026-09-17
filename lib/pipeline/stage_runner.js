'use strict'

/**
 * Runs one pipeline stage in the background, with a job row you can poll.
 *
 * The shape exists because of what a stage actually is: minutes of work over
 * hundreds of documents, kicked off by an HTTP request that must not wait for
 * it. So the route returns a job id immediately and the SPA polls
 * `GET /api/batches/:id/jobs/:jobId`. No websockets, no queue broker — for an
 * internal tool, polling a row is the boring choice that keeps working.
 *
 * What this gives every stage for free:
 *   - a lock, so two runs cannot overlap
 *   - an idempotency key, so a double-clicked button starts one job
 *   - progress counters the UI can render
 *   - a terminal status and an error message, always, including on crash
 *
 * Deliberately not included: retries. Retrying a stage that half-wrote is only
 * safe if the stage is idempotent, and whether yours is depends entirely on
 * your domain. Make the stage idempotent, then add retries in the caller.
 *
 * In-process background work has one honest limitation: a restart mid-stage
 * loses the run (boot recovery marks it cancelled, see lib/storage/database.js
 * — it does not resume). That is fine when stages are re-runnable and take
 * minutes. If yours take hours, move them to a worker process before that
 * becomes your outage.
 */

const { NotFoundError } = require('../errors')
const { logger } = require('../request_logger')

function createStageRunner({ db, lockManager, stageJobRepository }) {
  if (!db || !lockManager || !stageJobRepository) {
    throw new Error('db, lockManager and stageJobRepository are required')
  }

  /**
   * @param {object} params
   * @param {string} params.batchId
   * @param {string} params.stage             'recognize' | 'validate' | 'export' | …
   * @param {string} [params.idempotencyKey]  same key returns the existing job
   * @param {number} [params.userId]
   * @param {(ctx: { reportProgress: (done: number, total: number) => void, job: object }) => Promise<unknown>} params.work
   * @returns {{ jobId: number, reused: boolean }} returns as soon as the job row exists
   */
  function start({ batchId, stage, idempotencyKey = null, userId = null, work }) {
    if (typeof work !== 'function') throw new Error('work must be a function')

    if (idempotencyKey) {
      const existing = stageJobRepository.findByIdempotencyKey({ batchId, stage, idempotencyKey })
      // Reuse regardless of status: a completed job returned under its own key
      // is the correct answer to a repeated request, and re-running would
      // double-write.
      if (existing) return { jobId: existing.id, reused: true }
    }

    const job = stageJobRepository.create({ batchId, stage, idempotencyKey, userId })

    // Fire and forget, deliberately: the HTTP response must not wait. Errors
    // are recorded on the job row, which is why nothing is rethrown here.
    void runJob({ job, batchId, stage, work })

    return { jobId: job.id, reused: false }
  }

  async function runJob({ job, batchId, stage, work }) {
    const lockKey = `${stage}:${batchId}`
    try {
      await lockManager.withLock(
        lockKey,
        async () => {
          stageJobRepository.markRunning(job.id)
          logger.info('stage_started', { jobId: job.id, batchId, stage })

          const startedAt = Date.now()
          const result = await work({
            job,
            reportProgress: (done, total) => {
              // Throttling belongs in the caller, not here: a stage that
              // reports every document will write thousands of rows. Report
              // every N items or every few seconds.
              stageJobRepository.updateProgress(job.id, done, total)
            },
          })

          stageJobRepository.markSucceeded(job.id)
          logger.info('stage_succeeded', {
            jobId: job.id,
            batchId,
            stage,
            ms: Date.now() - startedAt,
          })
          return result
        },
        { holder: `pid:${process.pid}:${stage}` }
      )
    } catch (error) {
      // Including the lock conflict: "someone else is already running this"
      // is a legitimate terminal state for this job, and the operator needs to
      // see the reason rather than a job stuck at `queued`.
      stageJobRepository.markFailed(job.id, error?.message || String(error))
      logger.error('stage_failed', { err: error, jobId: job.id, batchId, stage })
    }
  }

  function getJob(jobId) {
    const job = stageJobRepository.findById(jobId)
    if (!job) throw new NotFoundError(`Job ${jobId} not found`)
    return job
  }

  return { start, getJob }
}

module.exports = { createStageRunner }
