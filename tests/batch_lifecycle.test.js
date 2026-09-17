'use strict'

/**
 * Batch lifecycle: create, lock, and the invariants that protect a closed
 * period.
 *
 * The lock tests are the ones that earn their keep. "Locked means locked" is
 * an invariant every write path has to honour, and the natural way to break it
 * is to add a new endpoint that forgets to check.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { createTestApp } = require('./helpers/test_app')

async function withLoggedInApp(t, options) {
  const ctx = await createTestApp(options)
  t.after(() => ctx.close())
  await ctx.login()
  return ctx
}

test('creating and reading a batch', async (t) => {
  const ctx = await withLoggedInApp(t)

  const created = await ctx.post('/api/batches', {
    id: 'b-2026-01-02',
    label: 'January 2nd',
    businessDay: '2026-01-02',
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.status, 'open')
  assert.equal(created.body.isLocked, false)

  const detail = await ctx.get('/api/batches/b-2026-01-02')
  assert.equal(detail.status, 200)
  assert.equal(detail.body.batch.label, 'January 2nd')
  assert.equal(detail.body.documents.total, 0)
  assert.ok(Array.isArray(detail.body.exportPlans))
})

test('a batch id that could escape the storage directory is rejected', async (t) => {
  const ctx = await withLoggedInApp(t)

  for (const id of ['../escape', 'a/b', 'has space', '', '.hidden']) {
    const response = await ctx.post('/api/batches', {
      id,
      label: 'x',
      businessDay: '2026-01-02',
    })
    assert.equal(response.status, 400, `id ${JSON.stringify(id)} must be rejected`)
    assert.equal(response.body.code, 'invalid_batch_id')
  }
})

test('a duplicate batch id is a 409, not a 500', async (t) => {
  const ctx = await withLoggedInApp(t)
  const payload = { id: 'dup', label: 'First', businessDay: '2026-01-02' }

  assert.equal((await ctx.post('/api/batches', payload)).status, 201)
  const second = await ctx.post('/api/batches', payload)
  assert.equal(second.status, 409)
  assert.equal(second.body.code, 'batch_exists')
})

test('a locked batch refuses writes and still allows reads', async (t) => {
  const ctx = await withLoggedInApp(t)
  await ctx.post('/api/batches', { id: 'locked', label: 'Closed', businessDay: '2026-01-02' })

  const locked = await ctx.post('/api/batches/locked/lock')
  assert.equal(locked.status, 200)
  assert.equal(locked.body.isLocked, true)

  // Reads keep working — exporting a closed period is the normal case.
  assert.equal((await ctx.get('/api/batches/locked')).status, 200)

  const upload = await ctx.post('/api/batches/locked/documents')
  assert.equal(upload.status, 409)
  assert.equal(upload.body.code, 'batch_locked')

  const recognize = await ctx.post('/api/batches/locked/stages/recognize')
  assert.equal(recognize.status, 409)
  assert.equal(recognize.body.code, 'batch_locked')
})

test('unlock restores writability', async (t) => {
  const ctx = await withLoggedInApp(t)
  await ctx.post('/api/batches', { id: 'reopen', label: 'x', businessDay: '2026-01-02' })
  await ctx.post('/api/batches/reopen/lock')

  const unlocked = await ctx.post('/api/batches/reopen/unlock')
  assert.equal(unlocked.status, 200)
  assert.equal(unlocked.body.isLocked, false)
})

test('unknown batch is 404 with a machine code', async (t) => {
  const ctx = await withLoggedInApp(t)
  const response = await ctx.get('/api/batches/does-not-exist')
  assert.equal(response.status, 404)
  assert.equal(response.body.code, 'not_found')
  assert.ok(response.body.requestId, 'every error must carry a request id')
})

test('the list endpoint caps an absurd page size', async (t) => {
  const ctx = await withLoggedInApp(t)
  const response = await ctx.get('/api/batches?limit=999999')
  assert.equal(response.status, 200)
  assert.ok(response.body.limit <= 200, `limit was ${response.body.limit}`)
})

test('an unknown API path returns JSON, not the SPA', async (t) => {
  const ctx = await withLoggedInApp(t)
  const response = await ctx.get('/api/nope')
  assert.equal(response.status, 404)
  assert.equal(response.body.code, 'unknown_endpoint')
})
