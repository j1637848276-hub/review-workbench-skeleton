'use strict'

/**
 * Config validation, health endpoints and the recognition seam.
 *
 * The config tests assert that misconfiguration is caught at boot. That is the
 * difference between a deploy that fails in the pipeline and one that goes
 * green and then 500s on the first login.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { loadConfig, publicConfigSummary } = require('../lib/config')
const { createTestApp } = require('./helpers/test_app')
const {
  createRecognitionClient,
  normalizeResult,
  registerProvider,
} = require('../lib/recognition/provider_registry')
const { UpstreamError } = require('../lib/errors')

function withEnv(overrides, fn) {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]))
  Object.assign(process.env, overrides)
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const VALID = {
  JWT_SECRET: 'a-secret-that-is-definitely-long-enough-32',
  AUTH_ENABLED: 'true',
  NODE_ENV: 'test',
}

test('a missing JWT secret fails at load, not at first request', async () => {
  withEnv({ ...VALID, JWT_SECRET: '' }, () => {
    assert.throws(() => loadConfig(), /JWT_SECRET is required/)
  })
})

test('a short JWT secret is rejected', async () => {
  withEnv({ ...VALID, JWT_SECRET: 'too-short' }, () => {
    assert.throws(() => loadConfig(), /at least 32 characters/)
  })
})

test('auth cannot be disabled in production', async () => {
  withEnv({ ...VALID, AUTH_ENABLED: 'false', NODE_ENV: 'production' }, () => {
    assert.throws(() => loadConfig(), /Refusing to start/)
  })
})

test('the http provider requires an endpoint', async () => {
  withEnv({ ...VALID, RECOGNITION_PROVIDER: 'http', RECOGNITION_ENDPOINT: '' }, () => {
    assert.throws(() => loadConfig(), /RECOGNITION_ENDPOINT is required/)
  })
})

test('an out-of-range review threshold is rejected', async () => {
  withEnv({ ...VALID, RECOGNITION_REVIEW_THRESHOLD: '85' }, () => {
    assert.throws(() => loadConfig(), /between 0 and 1/)
  })
})

test('the public config summary leaks no secret', async () => {
  withEnv(VALID, () => {
    const summary = JSON.stringify(publicConfigSummary(loadConfig()))
    assert.ok(!summary.includes(VALID.JWT_SECRET))
    assert.ok(!summary.toLowerCase().includes('secret'))
  })
})

test('health and readiness are reachable without authentication', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  const health = await ctx.get('/healthz')
  assert.equal(health.status, 200)
  assert.equal(health.body.status, 'ok')
  assert.ok(health.headers.get('x-app-boot'), 'the SPA needs this to detect a deploy')

  const ready = await ctx.get('/readyz')
  assert.equal(ready.status, 200)
  assert.equal(ready.body.status, 'ready')
  assert.equal(ready.body.checks.database.ok, true)
  assert.equal(ready.body.checks.storage.ok, true)
})

test('readiness reports not_ready when a probe fails, and stays up', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  ctx.container.healthProbes.flaky = () => {
    throw new Error('dependency is down')
  }

  const ready = await ctx.get('/readyz')
  assert.equal(ready.status, 503, 'the load balancer should drain, not restart')
  assert.equal(ready.body.checks.flaky.ok, false)
  assert.match(ready.body.checks.flaky.error, /dependency is down/)

  // Liveness must stay green: the process is fine, its dependency is not.
  assert.equal((await ctx.get('/healthz')).status, 200)
})

test('every response carries a request id', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  const response = await ctx.get('/api/batches')
  assert.ok(response.headers.get('x-request-id'))
  assert.equal(
    response.headers.get('x-request-id'),
    response.body.requestId ?? response.headers.get('x-request-id')
  )
})

test('an upstream request id is honoured so traces survive the proxy hop', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  const response = await ctx.get('/api/batches', { headers: { 'X-Request-Id': 'trace-me-123' } })
  assert.equal(response.headers.get('x-request-id'), 'trace-me-123')
})

test('security headers are set on every response', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  const response = await ctx.get('/healthz')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.match(response.headers.get('referrer-policy'), /strict-origin/)
  assert.equal(response.headers.get('x-powered-by'), null, 'do not advertise the framework')
})

test('the mock provider is deterministic per file', async () => {
  const client = createRecognitionClient({
    config: { recognition: { provider: 'mock', timeoutMs: 5000 } },
  })
  const first = await client.recognize({ filePath: '/tmp/a.png' })
  const second = await client.recognize({ filePath: '/tmp/a.png' })
  const other = await client.recognize({ filePath: '/tmp/b.png' })

  assert.deepEqual(first.fields, second.fields, 'same file must give the same result')
  assert.notDeepEqual(first.fields, other.fields)
})

test('normalizeResult clamps a provider that reports percentages', async () => {
  // A provider returning 0..100 would otherwise auto-approve everything,
  // because every value clears the threshold.
  const result = normalizeResult({ fields: [{ key: 'a', rawValue: 'x', confidence: 97 }] }, 'test')
  assert.equal(result.fields[0].confidence, 1)

  const missing = normalizeResult({ fields: [{ key: 'a', rawValue: 'x' }] }, 'test')
  assert.equal(
    missing.fields[0].confidence,
    0,
    'an absent confidence must not be treated as certain'
  )
})

test('normalizeResult drops malformed fields instead of throwing', async () => {
  const result = normalizeResult(
    { fields: [{ key: 'ok', rawValue: 1 }, { rawValue: 'no key' }, null, 'nonsense'] },
    'test'
  )
  assert.equal(result.fields.length, 1)
  assert.equal(result.fields[0].rawValue, '1')
})

test('a provider failure surfaces as UpstreamError', async () => {
  registerProvider({
    name: 'always-fails',
    async recognize() {
      throw new Error('model exploded')
    },
  })
  const client = createRecognitionClient({
    config: { recognition: { provider: 'always-fails', timeoutMs: 1000 } },
  })

  await assert.rejects(
    () => client.recognize({ filePath: '/tmp/x.png' }),
    (error) => {
      assert.ok(error instanceof UpstreamError)
      assert.equal(error.status, 502)
      assert.equal(error.code, 'recognition_failed')
      return true
    }
  )
})

test('an unknown provider name fails with a useful message', async () => {
  assert.throws(
    () => createRecognitionClient({ config: { recognition: { provider: 'nope' } } }),
    /Unknown recognition provider "nope".*Registered:/s
  )
})
