'use strict'

/**
 * Process entry point. Boot, listen, shut down cleanly.
 *
 * Everything that can fail is done *before* the port opens: config validation,
 * migrations, the bootstrap admin. A process that accepts connections and then
 * discovers it has no JWT secret gives you a deploy that looks green and an
 * application that 500s on first use.
 *
 * Run with:  node --env-file=.env server.js   (npm start)
 */

const fs = require('node:fs')
const path = require('node:path')

const { loadConfig } = require('./lib/config')
const { createGracefulShutdown } = require('./lib/graceful_shutdown')
const { createUploadMiddleware } = require('./lib/uploads')
const { logger } = require('./lib/request_logger')
const { createApp } = require('./server/create_app')
const { createContainer } = require('./server/container')

async function main() {
  const config = loadConfig({ projectRoot: __dirname })

  // Serve the built SPA when it exists. A backend-only checkout, or one where
  // the frontend has not been built yet, still starts and serves the API.
  const frontendDistDir = path.join(__dirname, 'frontend', 'dist')
  const hasFrontend = fs.existsSync(path.join(frontendDistDir, 'index.html'))
  if (!hasFrontend) {
    logger.warn('frontend_not_built', {
      hint: 'Run `npm run build:frontend` to serve the SPA from this process.',
    })
  }

  const container = createContainer({ config })

  // Migrations already ran inside createContainer. This is the other thing
  // that must happen before the port opens: a deployment nobody can sign in to
  // is not a deployment.
  if (config.auth.enabled) {
    await container.services.auth.ensureBootstrapAdmin()
  }

  const app = createApp({
    container,
    upload: createUploadMiddleware({ config }),
    frontendDistDir: hasFrontend ? frontendDistDir : null,
  })

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info('server_listening', {
      url: `http://${config.server.host}:${config.server.port}`,
      env: config.env,
      authEnabled: config.auth.enabled,
      recognitionProvider: config.recognition.provider,
      storageRoot: config.storage.root,
    })
  })

  // Uploads can legitimately take minutes on a slow uplink. Node's 2-minute
  // default kills them mid-transfer, and the client sees a bare network error
  // with nothing in the server log to explain it.
  server.requestTimeout = config.server.requestTimeoutMs
  server.headersTimeout = 60_000

  let draining = false
  const shutdown = createGracefulShutdown({
    server,
    graceMs: config.server.shutdownGraceMs,
    // Flip readiness first so the load balancer stops sending new work while
    // in-flight requests finish. /healthz stays 200 — the process is alive and
    // must not be killed mid-drain.
    onDraining: () => {
      draining = true
    },
  })

  container.healthProbes.draining = () => ({ ok: !draining, draining })

  shutdown.register('database', () => container.close())
  shutdown.listen()
}

main().catch((error) => {
  // Boot failures are the one place a bare console write is right: the logger
  // may itself be part of what failed, and the message has to reach the deploy
  // log no matter what.
  process.stderr.write(`Failed to start: ${error?.stack || error}\n`)
  process.exit(1)
})
