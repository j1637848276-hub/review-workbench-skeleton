'use strict'

/**
 * Shut down without corrupting anything.
 *
 * The order matters and is the only interesting part of this file:
 *
 *   1. Flip readiness to false. The load balancer stops sending new work
 *      *before* anything is closed, so in-flight requests are the only ones
 *      left to finish.
 *   2. Stop accepting new connections, let open ones drain.
 *   3. Run the registered hooks in reverse registration order — schedulers
 *      first, then the pool, then the database. Reverse order means a hook can
 *      safely depend on anything registered before it.
 *   4. Hard-exit after the grace period. A hung `db.close()` must not leave a
 *      zombie holding the port.
 *
 * SIGTERM and SIGINT both land here, and a second signal exits immediately —
 * an operator pressing Ctrl-C twice means it.
 */

const { logger } = require('./request_logger')

function createGracefulShutdown({ server, graceMs = 15_000, onDraining = null } = {}) {
  const hooks = []
  let shuttingDown = false

  /**
   * @param {string} name  shown in logs; name it after what breaks if it is skipped
   * @param {() => void | Promise<void>} fn
   */
  function register(name, fn) {
    if (typeof fn !== 'function') throw new Error(`shutdown hook "${name}" must be a function`)
    hooks.push({ name, fn })
  }

  async function runHooks() {
    for (const { name, fn } of [...hooks].reverse()) {
      try {
        await fn()
        logger.info('shutdown_hook_done', { hook: name })
      } catch (error) {
        // Keep going: one stuck hook must not block the rest from flushing.
        logger.error('shutdown_hook_failed', { hook: name, err: error })
      }
    }
  }

  async function shutdown(signal) {
    if (shuttingDown) {
      logger.warn('shutdown_forced', { signal })
      process.exit(1)
    }
    shuttingDown = true
    logger.info('shutdown_started', { signal, graceMs })

    // Step 1 — stop attracting traffic while we can still serve what we have.
    try {
      onDraining?.()
    } catch (error) {
      logger.error('shutdown_drain_hook_failed', { err: error })
    }

    const hardExit = setTimeout(() => {
      logger.error('shutdown_timeout', { graceMs })
      process.exit(1)
    }, graceMs)
    hardExit.unref()

    // Step 2 — close the listener, then wait for open sockets to finish.
    await new Promise((resolve) => {
      if (!server?.listening) return resolve()
      server.close(() => resolve())
    })

    // Step 3 — release resources.
    await runHooks()

    clearTimeout(hardExit)
    logger.info('shutdown_complete', { signal })
    process.exit(0)
  }

  function listen() {
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))

    // An unhandled rejection leaves the process in an unknown state. Log it
    // whole and go down so the supervisor restarts something known-good,
    // rather than serving from a half-broken heap.
    process.on('unhandledRejection', (reason) => {
      logger.error('unhandled_rejection', { err: reason })
      shutdown('unhandledRejection')
    })
    process.on('uncaughtException', (error) => {
      logger.error('uncaught_exception', { err: error })
      shutdown('uncaughtException')
    })
  }

  return {
    register,
    listen,
    shutdown,
    get shuttingDown() {
      return shuttingDown
    },
  }
}

module.exports = { createGracefulShutdown }
