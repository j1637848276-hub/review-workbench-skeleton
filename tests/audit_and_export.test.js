'use strict'

/**
 * Audit coverage and the export engine.
 *
 * The audit test is a *coverage* test, not a behaviour test: it walks the
 * registered Express routes and asserts that every mutating one is either in
 * the action map or on an explicit exemption list. That is what stops the slow
 * drift where a new endpoint ships unaudited and nobody notices for a year.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { createTestApp } = require('./helpers/test_app')
const { DEFAULT_ACTION_MAP } = require('../lib/audit_middleware')
const { buildWorkbookSpec } = require('../lib/export/export_plan_engine')
const { writeXlsx } = require('../lib/export/xlsx_writer')
const { EXPORT_PLANS } = require('../services/export_service')

/**
 * Mutating routes that deliberately produce no audit entry, with the reason.
 * Adding to this list should require justifying it in review.
 */
const AUDIT_EXEMPT = new Set([
  'POST /api/auth/password', // the entry would reveal that a reset happened for a named user
])

test('every mutating route is covered by the audit action map', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  // Express 5 keeps the registered stack on the app's router.
  const stack = ctx.app.router?.stack ?? ctx.app._router?.stack ?? []
  const routes = []
  for (const layer of stack) {
    if (!layer.route) continue
    const routePath = layer.route.path
    if (typeof routePath !== 'string' || !routePath.startsWith('/api')) continue
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled && method !== 'get') routes.push(`${method.toUpperCase()} ${routePath}`)
    }
  }

  assert.ok(routes.length > 0, 'no routes found — the introspection above needs updating')

  const uncovered = routes.filter((route) => {
    if (AUDIT_EXEMPT.has(route)) return false
    const [method, routePath] = route.split(' ')
    // Turn Express params into something the audit regexes can match.
    const concrete = routePath.replace(/:[^/]+/g, 'sample')
    return !DEFAULT_ACTION_MAP.some(
      (entry) => entry.method === method && entry.pattern.test(concrete)
    )
  })

  assert.deepEqual(
    uncovered,
    [],
    'these mutating routes write no audit entry — add them to DEFAULT_ACTION_MAP or AUDIT_EXEMPT'
  )
})

test('a successful login is audited, and so is a failed one', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  await ctx.login()
  await ctx.login({ password: 'wrong' })

  // The middleware writes on res.finish, which is after the response is sent.
  await new Promise((resolve) => setTimeout(resolve, 50))

  const { entries } = ctx.container.repositories.auditLog.search({ action: 'login' })
  assert.equal(entries.length, 2)

  const failed = entries.find((entry) => entry.statusCode === 401)
  assert.ok(failed, 'a failed login must be recorded — it is what an incident review needs')
  assert.equal(failed.username, 'tester', 'the attempted username must be captured')
  assert.ok(
    entries.every((entry) => entry.requestId),
    'entries must join to their log lines'
  )
})

test('an audit entry identifies which resource was created', async (t) => {
  // The batch id arrives in the request body, not the path, so it takes
  // `resourceIdFrom`. "Someone created a batch" without saying which one
  // fails to answer the only question this log exists for.
  const ctx = await createTestApp()
  t.after(() => ctx.close())
  await ctx.login()

  await ctx.post('/api/batches', { id: 'traced', label: 'x', businessDay: '2026-01-02' })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const { entries } = ctx.container.repositories.auditLog.search({ action: 'create_batch' })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].resourceId, 'traced')
  assert.equal(entries[0].resourceType, 'batch')
})

test('a rejected request writes no audit entry', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())
  await ctx.login()

  await ctx.post('/api/batches', { id: '../bad', label: 'x', businessDay: '2026-01-01' })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const { entries } = ctx.container.repositories.auditLog.search({ action: 'create_batch' })
  assert.equal(entries.length, 0, 'a 400 changed nothing and must not clutter the trail')
})

test('the audit log never stores a request body', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  await ctx.login()
  await new Promise((resolve) => setTimeout(resolve, 50))

  const { entries } = ctx.container.repositories.auditLog.search({})
  const serialized = JSON.stringify(entries)
  assert.ok(
    !serialized.includes(ctx.credentials.password),
    'a password must never reach the audit log'
  )
})

test('export totals are exact, not floating point', async () => {
  // 0.1 + 0.2 is why money goes through decimal.js. A reconciliation export
  // that is a cent off is worse than no export.
  const plan = {
    id: 'money',
    columns: [
      { header: 'Ref', key: 'ref' },
      { header: 'Amount', key: 'amount', type: 'money' },
    ],
    totals: ['amount'],
  }
  const rows = [
    { ref: 'a', amount: '0.10' },
    { ref: 'b', amount: '0.20' },
    { ref: 'c', amount: '1,000.05' },
  ]

  const spec = buildWorkbookSpec(plan, rows)
  // '1,000.05' has a separator and is not parseable as a number, so it is kept
  // visible in its row and excluded from the sum rather than silently coerced.
  assert.equal(spec.totals.amount, 0.3)
  assert.equal(spec.rows[0].amount, 0.1)
  assert.equal(spec.rows[2].amount, '1,000.05')
})

test('an unparseable money value stays visible instead of becoming zero', async () => {
  const spec = buildWorkbookSpec(
    { id: 'x', columns: [{ header: 'Amount', key: 'amount', type: 'money' }] },
    [{ amount: '1,2OO' }]
  )
  assert.equal(spec.rows[0].amount, '1,2OO', 'the operator needs to see what to fix')
})

test('an unknown column type is rejected when the plan is built', async () => {
  assert.throws(
    () => buildWorkbookSpec({ id: 'x', columns: [{ key: 'a', type: 'nonsense' }] }, []),
    /unknown type "nonsense"/
  )
})

test('every shipped export plan is valid and renders', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  for (const plan of Object.values(EXPORT_PLANS)) {
    const spec = buildWorkbookSpec(plan, [
      { document_no: 'DOC-1', total_amount: '10.00', currency: 'USD', min_confidence: 0.9 },
    ])
    const result = await writeXlsx(spec, path.join(dir, `${plan.id}.xlsx`))
    assert.ok(result.bytes > 0, `${plan.id} produced an empty file`)
    assert.equal(result.rows, 1)
  }
})
