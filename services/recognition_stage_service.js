'use strict'

/**
 * The recognition stage: run every pending document in a batch through the
 * configured provider, store the results, decide what needs a human.
 *
 * This is the example to copy when adding your own stage (validate, match,
 * reconcile, export). The shape is always the same:
 *
 *   1. Refuse to run against a locked batch.
 *   2. Hand the work to the stage runner, which owns the lock, the job row and
 *      the terminal status.
 *   3. Inside, process with bounded concurrency and report progress.
 *   4. Never let one bad item fail the batch.
 *
 * Bounded concurrency matters: `Promise.all` over 500 documents opens 500
 * simultaneous requests to your model service, which either rate-limits you or
 * falls over. A fixed pool of N workers pulling from one cursor keeps exactly
 * N in flight with no queue library.
 */

const path = require('node:path')

const { logger } = require('../lib/request_logger')

function createRecognitionStageService({
  config,
  batchRepository,
  documentRepository,
  recognitionClient,
  stageRunner,
}) {
  /**
   * Returns as soon as the job row exists — the work continues in the
   * background. Poll `GET /api/batches/:id/jobs/:jobId` for progress.
   */
  function start({ batchId, userId = null, idempotencyKey = null }) {
    batchRepository.assertWritable(batchId)

    return stageRunner.start({
      batchId,
      stage: 'recognize',
      idempotencyKey,
      userId,
      work: ({ reportProgress }) => runRecognition({ batchId, reportProgress }),
    })
  }

  async function runRecognition({ batchId, reportProgress }) {
    const pending = documentRepository.listPending(batchId)
    const total = pending.length
    if (total === 0) return { processed: 0, failed: 0 }

    batchRepository.setStatus(batchId, 'recognizing')

    let index = 0
    let processed = 0
    let failed = 0
    let lastReported = 0

    async function worker() {
      while (index < pending.length) {
        const document = pending[index++]
        try {
          const absolutePath = path.resolve(config.storage.root, document.storagePath)
          const result = await recognitionClient.recognize({
            filePath: absolutePath,
            docType: document.docType,
          })
          documentRepository.saveRecognitionResult({
            documentId: document.id,
            result,
            reviewThreshold: config.recognition.reviewThreshold,
          })
          processed += 1
        } catch (error) {
          // The document stays `pending`, so a re-run picks it up without
          // reprocessing everything that already succeeded.
          logger.error('recognition_failed', { err: error, documentId: document.id, batchId })
          failed += 1
        }

        const done = processed + failed
        // Report every 10 items: reporting per document would write hundreds
        // of rows for progress nobody can perceive at that resolution.
        if (done - lastReported >= 10 || done === total) {
          reportProgress(done, total)
          lastReported = done
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(config.recognition.concurrency, total) }, worker)
    )

    // A batch is only `in_review` if something is actually waiting on a human.
    const stillNeedingReview = documentRepository.reviewQueue({ batchId, limit: 1 }).length > 0
    batchRepository.setStatus(batchId, stillNeedingReview ? 'in_review' : 'ready')

    return { processed, failed, total }
  }

  return { start }
}

module.exports = { createRecognitionStageService }
