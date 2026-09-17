'use strict'

/**
 * The end-to-end path this skeleton exists to demonstrate:
 * ingest -> recognize -> queue -> correct -> approve.
 *
 * Driven through the container rather than multipart HTTP, because the
 * interesting assertions are about state transitions, not about multer. The
 * upload route itself is covered in batch_lifecycle.test.js.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const { createTestApp } = require('./helpers/test_app')

/** Writes files shaped like multer output, so intake runs its real path. */
function stageFiles(ctx, count) {
  return Array.from({ length: count }, (_unused, index) => {
    const filePath = path.join(ctx.config.storage.tmpUploadRoot, `t-${index}.png`)
    // Distinct bytes per file: identical content would (correctly) be
    // deduplicated by intake and the test would silently ingest one document.
    fs.writeFileSync(
      filePath,
      Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, index)])
    )
    return { path: filePath, originalname: `scan_${index}.png`, size: 40 }
  })
}

async function waitForJob(ctx, jobId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let job = ctx.container.stageRunner.getJob(jobId)
  while (!job.isTerminal && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    job = ctx.container.stageRunner.getJob(jobId)
  }
  assert.ok(job.isTerminal, `job ${jobId} did not finish: ${job.status}`)
  return job
}

async function seedRecognizedBatch(t, { count = 6 } = {}) {
  const ctx = await createTestApp()
  t.after(() => ctx.close())
  await ctx.login()

  const batchId = 'b1'
  ctx.container.repositories.batches.create({
    id: batchId,
    label: 'Test',
    businessDay: '2026-01-02',
  })
  await ctx.container.services.intake.ingest({ batchId, files: stageFiles(ctx, count) })

  const { jobId } = ctx.container.services.recognitionStage.start({ batchId })
  const job = await waitForJob(ctx, jobId)
  assert.equal(job.status, 'succeeded')

  return { ctx, batchId }
}

test('intake deduplicates identical content', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  ctx.container.repositories.batches.create({ id: 'dedup', label: 'x', businessDay: '2026-01-02' })

  const makeFile = (name) => {
    const filePath = path.join(ctx.config.storage.tmpUploadRoot, name)
    fs.writeFileSync(filePath, Buffer.from('identical bytes'))
    return { path: filePath, originalname: name, size: 15 }
  }

  const first = await ctx.container.services.intake.ingest({
    batchId: 'dedup',
    files: [makeFile('a.png')],
  })
  assert.equal(first.accepted.length, 1)

  // Same bytes, different filename — the case where an operator re-sends a
  // folder after a network drop.
  const second = await ctx.container.services.intake.ingest({
    batchId: 'dedup',
    files: [makeFile('b.png')],
  })
  assert.equal(second.accepted.length, 0)
  assert.equal(second.duplicates.length, 1)
})

test('recognition routes low-confidence documents to review', async (t) => {
  const { ctx, batchId } = await seedRecognizedBatch(t, { count: 8 })

  const queue = await ctx.get(`/api/documents/queue?batchId=${batchId}`)
  assert.equal(queue.status, 200)
  assert.ok(queue.body.documents.length > 0, 'the mock provider should produce review work')

  // Worst first — the queue must hand out the riskiest document next.
  const confidences = queue.body.documents.map((document) => document.minConfidence)
  assert.deepEqual(
    confidences,
    [...confidences].sort((a, b) => a - b)
  )

  for (const document of queue.body.documents) {
    assert.equal(document.status, 'needs_review')
    assert.ok(document.minConfidence < ctx.config.recognition.reviewThreshold)
  }
})

test('a correction is recorded with history and marks the field human-sourced', async (t) => {
  const { ctx, batchId } = await seedRecognizedBatch(t)
  const [document] = await ctx
    .get(`/api/documents/queue?batchId=${batchId}`)
    .then((response) => response.body.documents)

  const before = await ctx.get(`/api/documents/${document.id}`)
  const original = before.body.fields.find((field) => field.key === 'total_amount')

  const patched = await ctx.patch(`/api/documents/${document.id}/fields`, {
    // Deliberately messy input: the normaliser should strip the separator and
    // the currency symbol.
    corrections: { total_amount: '1,234.50 USD' },
    reason: 'read from the printed total',
  })
  assert.equal(patched.status, 200)
  assert.deepEqual(patched.body.changed, ['total_amount'])

  const corrected = patched.body.fields.find((field) => field.key === 'total_amount')
  assert.equal(corrected.value, '1234.50')
  assert.equal(corrected.source, 'human')
  assert.equal(corrected.corrected, true)
  assert.equal(corrected.confidence, 1, 'a human value is certain by definition')
  assert.equal(
    corrected.rawValue,
    original.rawValue,
    'raw_value must keep the model output for accuracy measurement'
  )

  const detail = await ctx.get(`/api/documents/${document.id}`)
  const entry = detail.body.history.find((row) => row.field_key === 'total_amount')
  assert.ok(entry, 'the change must appear in field_history')
  assert.equal(entry.new_value, '1234.50')
  assert.equal(entry.old_value, original.value)
})

test('a no-op correction writes no history', async (t) => {
  const { ctx, batchId } = await seedRecognizedBatch(t)
  const [document] = await ctx
    .get(`/api/documents/queue?batchId=${batchId}`)
    .then((response) => response.body.documents)

  const fields = await ctx.get(`/api/documents/${document.id}`).then((r) => r.body.fields)
  const currency = fields.find((field) => field.key === 'currency')

  const response = await ctx.patch(`/api/documents/${document.id}/fields`, {
    corrections: { currency: currency.value },
  })
  assert.deepEqual(response.body.changed, [], 'unchanged values must not pollute the trail')
})

test('a document cannot be reviewed twice', async (t) => {
  const { ctx, batchId } = await seedRecognizedBatch(t)
  const [document] = await ctx
    .get(`/api/documents/queue?batchId=${batchId}`)
    .then((response) => response.body.documents)

  const first = await ctx.post(`/api/documents/${document.id}/review`, { decision: 'approved' })
  assert.equal(first.status, 200)
  assert.equal(first.body.status, 'approved')

  // Two reviewers opening the same queue item is normal; silently overwriting
  // the first decision is not.
  const second = await ctx.post(`/api/documents/${document.id}/review`, { decision: 'rejected' })
  assert.equal(second.status, 409)
  assert.equal(second.body.code, 'already_reviewed')
})

test('an invalid review decision is rejected', async (t) => {
  const { ctx, batchId } = await seedRecognizedBatch(t)
  const [document] = await ctx
    .get(`/api/documents/queue?batchId=${batchId}`)
    .then((response) => response.body.documents)

  const response = await ctx.post(`/api/documents/${document.id}/review`, { decision: 'maybe' })
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'invalid_decision')
})

test('an idempotency key returns the same job instead of starting a second', async (t) => {
  const { ctx, batchId } = await seedRecognizedBatch(t)

  const first = ctx.container.services.recognitionStage.start({ batchId, idempotencyKey: 'run-1' })
  const second = ctx.container.services.recognitionStage.start({ batchId, idempotencyKey: 'run-1' })

  assert.equal(second.jobId, first.jobId)
  assert.equal(second.reused, true)
})

test('clearing the queue advances the batch to ready', async (t) => {
  const { ctx, batchId } = await seedRecognizedBatch(t)

  let queue = await ctx.get(`/api/documents/queue?batchId=${batchId}`)
  for (const document of queue.body.documents) {
    await ctx.post(`/api/documents/${document.id}/review`, { decision: 'approved' })
  }

  queue = await ctx.get(`/api/documents/queue?batchId=${batchId}`)
  assert.equal(queue.body.documents.length, 0)

  const batch = await ctx.get(`/api/batches/${batchId}`)
  assert.equal(batch.body.batch.status, 'ready')
})
