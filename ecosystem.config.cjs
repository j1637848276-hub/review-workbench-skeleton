/**
 * PM2 process definition.
 *
 * PM2 rather than a bare `node server.js`: it restarts on crash, rotates logs,
 * and survives a reboot via `pm2 startup`. systemd does the same job at least
 * as well — use whichever your host already runs, but do use one of them.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs review-workbench
 *   pm2 reload review-workbench    # zero-downtime, uses the graceful shutdown
 *   pm2 save                       # persist across reboots
 */
module.exports = {
  apps: [
    {
      name: 'review-workbench',
      script: 'server.js',
      cwd: __dirname,

      // Single instance, and this is not an oversight. SQLite serialises
      // writes, and the in-process pieces — the advisory locks, the rate
      // limiter, the stage runner's background work — assume one process.
      // Cluster mode would give you N rate limiters and racing stages.
      // Outgrown that? Move to Postgres and a real queue first.
      instances: 1,
      exec_mode: 'fork',

      node_args: ['--env-file=.env'],

      // Restart on crash, but give up if it crashes immediately and
      // repeatedly: a config error should surface as a stopped process in
      // `pm2 list`, not as an infinite restart loop burning the CPU.
      autorestart: true,
      min_uptime: '20s',
      max_restarts: 5,
      restart_delay: 2000,

      // A restart at this threshold usually means a leak. Set it above your
      // steady-state usage — an export of a large batch is legitimately heavy,
      // and killing it mid-write is worse than the memory.
      max_memory_restart: '600M',

      // PM2 sends SIGINT, which lib/graceful_shutdown.js handles. Allow more
      // than the app's own grace period so the app finishes first.
      kill_timeout: 20_000,
      // Wait for the app's own ready signal instead of assuming it is up the
      // moment the process spawns — migrations run before the port opens.
      wait_ready: false,
      listen_timeout: 30_000,

      // stdout is JSON lines already (see lib/request_logger.js), so do not
      // let PM2 prefix them — that would break `jq`.
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: false,

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
