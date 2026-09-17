'use strict'

/**
 * Auth behaviour, including the parts that are easy to break by accident.
 *
 * Note what is asserted here beyond the happy path: that a wrong username and
 * a wrong password give the *same* response, that the token never appears in a
 * body, and that role gating returns 403 rather than 401. Each of those is a
 * regression someone will introduce while "simplifying" the auth code.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { createTestApp } = require('./helpers/test_app')
const { hashPassword, verifyPassword, needsRehash } = require('../lib/auth/password')

test('password hashing round-trips and rejects wrong input', async () => {
  const hash = await hashPassword('correct-horse-battery')
  assert.ok(hash.startsWith('scrypt$'))
  assert.equal(await verifyPassword('correct-horse-battery', hash), true)
  assert.equal(await verifyPassword('wrong-password-here', hash), false)
  assert.equal(await verifyPassword('correct-horse-battery', 'garbage'), false)
  assert.equal(needsRehash(hash), false)
})

test('the same password produces different hashes', async () => {
  // Salting. Equal hashes would mean identical passwords are visibly identical
  // in the database, which is the whole point of a salt.
  const [a, b] = await Promise.all([
    hashPassword('same-password-12'),
    hashPassword('same-password-12'),
  ])
  assert.notEqual(a, b)
})

test('login sets an httpOnly cookie and never returns the token', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  const response = await ctx.login()
  assert.equal(response.status, 200)
  assert.equal(response.body.user.username, 'tester')
  assert.equal(response.body.token, undefined, 'token must not be in the response body')

  const setCookie = response.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Lax/i)
})

test('wrong username and wrong password are indistinguishable', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  const noSuchUser = await ctx.login({ username: 'nobody' })
  const wrongPassword = await ctx.login({ password: 'not-the-password' })

  assert.equal(noSuchUser.status, 401)
  assert.equal(wrongPassword.status, 401)

  // requestId is unique per request by design, so compare everything else.
  // Any difference here — a distinct code, a more specific message — is an
  // account enumeration oracle.
  const withoutRequestId = ({ requestId: _ignored, ...rest }) => rest
  assert.deepEqual(withoutRequestId(noSuchUser.body), withoutRequestId(wrongPassword.body))
})

test('protected routes reject an unauthenticated caller', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  const response = await ctx.get('/api/batches')
  assert.equal(response.status, 401)
  assert.equal(response.body.code, 'no_token')
})

test('insufficient role gives 403, not 401', async (t) => {
  // The distinction matters: the SPA redirects to login on 401, so returning
  // 401 here would bounce a signed-in user out of the app instead of telling
  // them they lack permission.
  const ctx = await createTestApp({ seedAdmin: false })
  t.after(() => ctx.close())

  await ctx.container.services.auth.createUser({
    username: 'viewer-only',
    password: 'viewer-password-1',
    role: 'viewer',
  })
  await ctx.post('/api/auth/login', { username: 'viewer-only', password: 'viewer-password-1' })

  const response = await ctx.post('/api/batches', {
    id: 'b1',
    label: 'Nope',
    businessDay: '2026-01-01',
  })
  assert.equal(response.status, 403)
})

test('login is rate limited after repeated failures', async (t) => {
  const ctx = await createTestApp({ env: { LOGIN_RATE_LIMIT_MAX: '3' } })
  t.after(() => ctx.close())

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await ctx.login({ password: 'wrong' })
    assert.equal(response.status, 401)
  }

  const blocked = await ctx.login({ password: 'wrong' })
  assert.equal(blocked.status, 429)
  assert.ok(blocked.headers.get('retry-after'))
})

test('a successful login does not consume rate-limit budget', async (t) => {
  // Otherwise a user who signs in and out a few times locks themselves out.
  const ctx = await createTestApp({ env: { LOGIN_RATE_LIMIT_MAX: '2' } })
  t.after(() => ctx.close())

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await ctx.login()
    assert.equal(response.status, 200, `attempt ${attempt + 1} should succeed`)
  }
})

test('the AUTH_ENABLED=false dev bypass can actually write', async (t) => {
  // Regression: the bypass used to fabricate `user.id = 0`. Every
  // created_by / reviewed_by / triggered_by column is a foreign key to
  // user(id), so the first write failed with "FOREIGN KEY constraint failed" —
  // a 500 on the very first thing a newcomer does after turning auth off.
  const ctx = await createTestApp({ env: { AUTH_ENABLED: 'false' }, seedAdmin: false })
  t.after(() => ctx.close())

  // No cookie sent, and it still works — that is the point of the bypass.
  const created = await ctx.post('/api/batches', {
    id: 'dev-batch',
    label: 'Dev',
    businessDay: '2026-01-02',
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.createdBy, null)
})

test('the last active admin cannot be demoted', async (t) => {
  const ctx = await createTestApp()
  t.after(() => ctx.close())

  const admin = ctx.container.repositories.users.findByUsername('tester')
  assert.throws(
    () => ctx.container.repositories.users.setRole(admin.id, 'viewer'),
    /last active admin/
  )
})
