'use strict'

/**
 * Auth endpoints.
 *
 *   POST /api/auth/login    set the session cookie
 *   POST /api/auth/logout   clear it
 *   GET  /api/auth/me       who am I (the SPA calls this on boot)
 *
 * Routes stay thin: parse, delegate, shape the response. No business rules
 * here — everything interesting is in `services/auth_service.js`, which is
 * testable without an HTTP server.
 *
 * `asyncRoute` exists because Express 5 forwards a rejected promise to the
 * error handler, but only if the handler actually returns one. Wrapping makes
 * that explicit and survives a refactor to a non-async handler.
 */

const { createRateLimiter } = require('../lib/auth/rate_limiter')
const { clearAuthCookie, setAuthCookie } = require('../lib/auth/jwt_middleware')

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

function registerAuthRoutes({ app, authService, config, authenticate }) {
  // Per-IP, failures only. See lib/auth/rate_limiter.js for what this does and
  // does not protect against.
  const loginLimiter = createRateLimiter({
    windowMs: config.auth.loginRateLimitWindowMs,
    max: config.auth.loginRateLimitMax,
    message: 'Too many failed sign-in attempts. Please wait and try again.',
  })

  app.post(
    '/api/auth/login',
    loginLimiter,
    asyncRoute(async (req, res) => {
      const { username, password } = req.body ?? {}
      const { user, token } = await authService.login({ username, password })

      setAuthCookie(res, token, { secure: config.auth.cookieSecure })
      // The token is set as an httpOnly cookie and deliberately not returned
      // in the body — putting it there would let a script read it, which is
      // the entire thing the cookie avoids.
      res.json({ user })
    })
  )

  app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res)
    res.json({ ok: true })
  })

  app.get(
    '/api/auth/me',
    authenticate,
    asyncRoute(async (req, res) => {
      res.json({ user: req.user })
    })
  )

  app.post(
    '/api/auth/password',
    authenticate,
    asyncRoute(async (req, res) => {
      const { currentPassword, newPassword } = req.body ?? {}
      await authService.changePassword({
        userId: req.user.id,
        currentPassword,
        newPassword,
        requireCurrent: true,
      })
      // Force a fresh sign-in: any other session on the old password should
      // not keep working after a deliberate password change.
      clearAuthCookie(res)
      res.json({ ok: true, reauthenticate: true })
    })
  )
}

module.exports = { registerAuthRoutes, asyncRoute }
