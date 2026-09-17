'use strict'

/**
 * Password hashing on `node:crypto` scrypt — no native dependency.
 *
 * bcrypt and argon2 are both fine choices and argon2id is the stronger one;
 * they are avoided here only because a skeleton that needs a C++ toolchain to
 * `npm ci` on a fresh machine is a skeleton people abandon. scrypt is
 * memory-hard, ships with Node, and is a legitimate choice at these
 * parameters. If you already have a build pipeline, swapping in argon2id is a
 * contained change: `hashPassword` and `verifyPassword` are the only callers,
 * and the stored format below is self-describing so old hashes keep verifying.
 *
 * Stored format:  scrypt$N$r$p$<salt-b64>$<hash-b64>
 */

const crypto = require('node:crypto')
const { promisify } = require('node:util')

const scrypt = promisify(crypto.scrypt)

// ~64 MB and roughly 100 ms per hash on 2024 server hardware. Raise N as
// hardware improves; existing hashes keep their own parameters and still
// verify, because the parameters travel with the hash.
const PARAMS = Object.freeze({ N: 2 ** 16, r: 8, p: 1, keyLen: 32, saltLen: 16 })
const MIN_PASSWORD_LENGTH = 12

function assertAcceptable(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  // Node's scrypt rejects nothing here, but an unbounded password is free CPU
  // for an attacker: each attempt costs the server ~100 ms regardless.
  if (password.length > 200) {
    throw new Error('Password must be at most 200 characters.')
  }
}

async function hashPassword(password) {
  assertAcceptable(password)
  const salt = crypto.randomBytes(PARAMS.saltLen)
  const derived = await scrypt(password, salt, PARAMS.keyLen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 256 * 1024 * 1024,
  })
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

/**
 * Always returns a boolean — a malformed stored hash is a failed login, not an
 * exception that leaks which accounts have corrupt records.
 */
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts
  const N = Number.parseInt(nRaw, 10)
  const r = Number.parseInt(rRaw, 10)
  const p = Number.parseInt(pRaw, 10)
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false

  try {
    const expected = Buffer.from(hashB64, 'base64')
    const derived = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    })
    // Constant-time: a length-dependent early return would leak hash length.
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

/** True when a hash was produced with weaker parameters than current policy. */
function needsRehash(stored) {
  const parts = String(stored || '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true
  return Number.parseInt(parts[1], 10) < PARAMS.N
}

module.exports = { hashPassword, verifyPassword, needsRehash, MIN_PASSWORD_LENGTH }
