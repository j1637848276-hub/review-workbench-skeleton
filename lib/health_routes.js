'use strict'

/**
 * /healthz and /readyz — two endpoints answering two different questions.
 *
 *   /healthz  liveness.  "Is this process alive?" Always 200 unless the event
 *             loop is wedged, in which case nothing answers and the caller's
 *             timeout is the signal. Restart on failure.
 *   /readyz   readiness. "Should this process receive traffic?" Opens the DB,
 *             checks the queue depth, whatever else you register. 503 while
 *             migrations run or a dependency is down. Drain on failure — do
 *             NOT restart, or a slow dependency turns into a crash loop.
 *
 * Both are deliberately unauthenticated so PM2, systemd and your load balancer
 * can probe them. That is also why the response must stay boring: uptime,
 * version, per-probe ok/not-ok. No config dump, no counts that reveal volume.
 *
 * A probe returning `{ ok: false }` or throwing marks the service not ready but
 * never takes the endpoint itself down — a broken probe must not look like a
 * broken service.
 */

function createHealthRoutes({ probes = {}, meta = {} } = {}) {
  const startedAt = new Date().toISOString()

  async function runProbe(name) {
    const probe = probes[name]
    if (typeof probe !== 'function') return { ok: true, skipped: true }
    try {
      const result = await probe()
      if (result && typeof result === 'object') return { ok: result.ok !== false, ...result }
      return { ok: Boolean(result) }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  function register(app) {
    app.get('/healthz', (_req, res) => {
      res.json({
        status: 'ok',
        startedAt,
        uptimeSec: Math.round(process.uptime()),
        ...meta,
      })
    })

    app.get('/readyz', async (_req, res) => {
      const checks = {}
      // Sequential on purpose: the probe set is small and a readiness check
      // should not itself become load on the thing it is checking.
      for (const name of Object.keys(probes)) {
        checks[name] = await runProbe(name)
      }
      const ready = Object.values(checks).every((check) => check.ok)
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        startedAt,
        uptimeSec: Math.round(process.uptime()),
        checks,
        ...meta,
      })
    })
  }

  return { register }
}

module.exports = { createHealthRoutes }
