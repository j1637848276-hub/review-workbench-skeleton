'use strict'

/**
 * Builds a real app against a throwaway storage directory.
 *
 * Deliberately not mocked. These tests run the actual middleware chain, the
 * actual migrations and the actual SQLite file, because that is where the bugs
 * are — middleware ordering, a migration that fails on an empty table, a
 * transaction that does not roll back. A suite of mocks would pass while the
 * server fails to boot.
 *
 * Each call gets its own temp directory, so tests are independent and can run
 * in parallel.
 *
 *   const ctx = await createTestApp()
 *   t.after(() => ctx.close())
 *   const res = await ctx.post('/api/auth/login', { username, password })
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { loadConfig } = require('../../lib/config')
const { createNoopUpload } = require('../../lib/uploads')
const { createApp } = require('../../server/create_app')
const { createContainer } = require('../../server/container')

const TEST_SECRET = 'test-secret-that-is-long-enough-to-pass-validation'

async function createTestApp({ env = {}, seedAdmin = true, upload = null } = {}) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-test-'))

  // Snapshot and restore: tests share one process, so leaking env vars makes
  // failures depend on file order — the least debuggable kind.
  const applied = {
    STORAGE_ROOT: storageRoot,
    JWT_SECRET: TEST_SECRET,
    AUTH_ENABLED: 'true',
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    RECOGNITION_PROVIDER: 'mock',
    BOOTSTRAP_ADMIN_PASSWORD: '',
    ...env,
  }
  const previous = Object.fromEntries(Object.keys(applied).map((key) => [key, process.env[key]]))
  Object.assign(process.env, applied)

  const config = loadConfig({ projectRoot: storageRoot })
  const container = createContainer({ config })

  const credentials = { username: 'tester', password: 'test-password-123' }
  if (seedAdmin) {
    await container.services.auth.createUser({ ...credentials, role: 'admin' })
  }

  const app = createApp({ container, upload: upload ?? createNoopUpload() })
  // Port 0: the OS picks a free one, so parallel test files cannot collide.
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  // Cookie jar. Enough for one session, which is all a test needs.
  let cookie = ''

  async function request(method, urlPath, body, { headers = {}, raw = false } = {}) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    const setCookie = response.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]

    if (raw) return response
    const text = await response.text()
    let json
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text } // an HTML error page is itself the assertion
    }
    return { status: response.status, headers: response.headers, body: json }
  }

  async function login(overrides = {}) {
    return request('POST', '/api/auth/login', { ...credentials, ...overrides })
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve))
    container.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(storageRoot, { recursive: true, force: true })
  }

  return {
    app,
    server,
    baseUrl,
    config,
    container,
    credentials,
    login,
    close,
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b, o) => request('POST', p, b, o),
    patch: (p, b, o) => request('PATCH', p, b, o),
    delete: (p, o) => request('DELETE', p, undefined, o),
    clearCookie: () => {
      cookie = ''
    },
  }
}

module.exports = { createTestApp, TEST_SECRET }
