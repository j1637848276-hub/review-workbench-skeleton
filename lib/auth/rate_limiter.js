'use strict'

/**
 * In-memory fixed-window rate limiter, sized for a single-process workbench.
 *
 * Deliberately not Redis-backed: one Node process serving an internal tool
 * does not need a distributed counter, and the dependency would outweigh the
 * benefit. The limits of this choice, stated plainly so nobody discovers them
 * in production:
 *
 *  - Counters live in process memory, so a restart forgives every attacker.
 *  - Behind N replicas the effective limit is N x max.
 *
 * Run more than one replica, or care about either point? Move this to Redis or
 * express it as a reverse-proxy rule. The interface below does not change.
 *
 * `skipSuccessfulRequests` (default on) refunds the slot when the response is
 * under 400, so the window only counts *failures*. Without it, a user who
 * signs in and out five times is locked out for no reason.
 */

function createRateLimiter({
  windowMs = 60_000,
  max = 5,
  message = 'Too many attempts. Please retry later.',
  code = 'rate_limited',
  statusCode = 429,
  keyGenerator = (req) => req.ip || req.socket?.remoteAddress || 'unknown',
  skipSuccessfulRequests = true,
} = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be positive')
  if (!Number.isFinite(max) || max <= 0) throw new Error('max must be positive')

  const buckets = new Map()

  function prune(now) {
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) buckets.delete(key)
    }
  }

  return function rateLimiter(req, res, next) {
    const now = Date.now()
    // Bounded sweep instead of a timer: no interval to clear on shutdown, and
    // the map cannot grow without bound from spoofed source addresses.
    if (buckets.size > 10_000) prune(now)

    const key = keyGenerator(req)
    let bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
    }

    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(statusCode).json({ error: message, code, retryAfter })
    }

    bucket.count += 1
    if (skipSuccessfulRequests) {
      res.on('finish', () => {
        if (res.statusCode < 400) bucket.count = Math.max(0, bucket.count - 1)
      })
    }

    return next()
  }
}

module.exports = { createRateLimiter }
