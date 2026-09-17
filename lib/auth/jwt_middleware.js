'use strict'

/**
 * JWT in an httpOnly cookie, plus role gating.
 *
 * Cookie, not `Authorization: Bearer`. For a first-party SPA that is the safer
 * default: an httpOnly cookie is unreadable from JavaScript, so an XSS bug
 * cannot exfiltrate the session the way a token in localStorage can. The cost
 * is CSRF exposure, which `sameSite` covers for a single-origin app — if you
 * add a second origin, add a CSRF token; do not reach for `sameSite: 'none'`.
 *
 * `sameSite: 'lax'` rather than `'strict'`: strict drops the cookie on
 * `<img src="/storage/…">` and on any cross-site navigation into the app,
 * which shows up as random 401s on image loads. lax is sufficient for a
 * single-origin workbench.
 *
 * Two status codes, two meanings, and the SPA depends on the difference:
 *   401 — not (or no longer) authenticated. The interceptor redirects to login.
 *   403 — authenticated, insufficient role. Show a message; a redirect here
 *         would bounce a legitimately signed-in user out of the app.
 */

const jwt = require('jsonwebtoken')

const { attachUserToContext, logger } = require('../request_logger')

const TOKEN_COOKIE_NAME = 'token'
const DEFAULT_EXPIRES_IN = '24h'
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Roles allowed to reach the application at all. Extend for your domain. */
const ACTIVE_ROLES = Object.freeze(['admin', 'reviewer', 'viewer'])

function resolveSecret(options = {}) {
  const secret = options.secret || process.env.JWT_SECRET
  if (!secret) throw new Error('[auth] JWT_SECRET is required. Set it in .env before starting.')
  return secret
}

function toTokenPayload(user) {
  // Claims only. Never put anything the client should not read in here — a JWT
  // payload is base64, not encrypted.
  return { userId: user.id, username: user.username, role: user.role }
}

function generateToken(user, options = {}) {
  return jwt.sign(toTokenPayload(user), resolveSecret(options), {
    expiresIn: options.expiresIn || DEFAULT_EXPIRES_IN,
  })
}

function buildAuthCookieOptions(options = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(options.secure),
    maxAge: options.maxAge || DEFAULT_MAX_AGE_MS,
    path: '/',
  }
}

function setAuthCookie(res, token, options = {}) {
  res.cookie(TOKEN_COOKIE_NAME, token, buildAuthCookieOptions(options))
}

function clearAuthCookie(res) {
  res.cookie(TOKEN_COOKIE_NAME, '', { httpOnly: true, sameSite: 'lax', maxAge: 0, path: '/' })
}

/**
 * Verifies the cookie and re-reads the user from storage on every request.
 *
 * The extra read is deliberate. Without it, a 24-hour token keeps working
 * after an account is disabled or demoted — you cannot revoke anything until
 * it expires. One indexed primary-key lookup per request is a cheap price for
 * "deactivating an account takes effect now".
 *
 * Pass `userService: null` to skip the lookup and trust the token's claims
 * (fine for tests, not for production).
 */
function authenticateToken(options = {}) {
  return async function authenticate(req, res, next) {
    const token = req.cookies?.[TOKEN_COOKIE_NAME]
    if (!token) return res.status(401).json({ error: 'Unauthorized', code: 'no_token' })

    let payload
    try {
      payload = jwt.verify(token, resolveSecret(options))
    } catch {
      // Expired or tampered. 401 so the SPA sends the user to login instead of
      // leaving them on a page where every action silently fails.
      return res.status(401).json({ error: 'Unauthorized', code: 'token_invalid' })
    }

    const userId = Number(payload.userId)

    if (options.userService) {
      let user
      try {
        user = await options.userService.getUserById(userId)
      } catch (error) {
        logger.error('auth_user_lookup_failed', { err: error, userId })
        return res.status(503).json({ error: 'Auth backend unavailable', code: 'auth_unavailable' })
      }
      if (!user || !user.isActive || !ACTIVE_ROLES.includes(user.role)) {
        return res.status(401).json({ error: 'Unauthorized', code: 'user_inactive' })
      }
      req.user = { id: user.id, username: user.username, role: user.role }
    } else {
      req.user = { id: userId, username: payload.username, role: payload.role }
    }

    attachUserToContext(req.user.id)
    return next()
  }
}

/**
 * requireRole('reviewer')            — reviewer, plus admin implicitly
 * requireRole('finance', 'admin')    — either
 * requireRole(['finance'], { allowAdmin: false })
 *
 * admin passes by default because in practice every deployment ends up adding
 * admin to each list. Opt out where that is genuinely wrong — a
 * four-eyes approval step, say, where an admin must not self-approve.
 */
function requireRole(...args) {
  const roles = Array.isArray(args[0]) ? args[0] : args
  const opts = { allowAdmin: true, ...(Array.isArray(args[0]) ? args[1] || {} : {}) }

  return function roleGate(req, res, next) {
    const role = req.user?.role
    if (!role) return res.status(401).json({ error: 'Unauthorized', code: 'no_user' })
    if (opts.allowAdmin && role === 'admin') return next()
    if (roles.includes(role)) return next()
    return res.status(403).json({ error: 'Insufficient permissions', code: 'forbidden' })
  }
}

module.exports = {
  ACTIVE_ROLES,
  TOKEN_COOKIE_NAME,
  authenticateToken,
  buildAuthCookieOptions,
  clearAuthCookie,
  generateToken,
  requireRole,
  resolveSecret,
  setAuthCookie,
}
