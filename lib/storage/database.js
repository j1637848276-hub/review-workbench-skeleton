'use strict'

/**
 * Opens the SQLite database on `node:sqlite` (Node 22.5+), applies migrations,
 * and runs crash recovery.
 *
 * Why SQLite for a multi-user internal tool: one file, no server to operate,
 * atomic backups by copy, and it comfortably handles the read-heavy load of a
 * few dozen operators. The ceiling is writes — SQLite serialises them — so if
 * your write path becomes the bottleneck, that is the signal to move to
 * Postgres, not a reason to avoid starting here. Keeping every query behind
 * `repositories/` is what makes that move contained.
 *
 * Why `node:sqlite` over `better-sqlite3`: no native build step. The
 * synchronous API is the same shape, so porting either direction is mechanical.
 */

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const { runMigrations } = require('./migration_runner')

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

function openDatabase({ dbPath, migrationsDir = MIGRATIONS_DIR, logger } = {}) {
  if (!dbPath) throw new Error('dbPath is required')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = new DatabaseSync(dbPath)

  // WAL: readers never block the writer, which is what makes a browsing
  // operator and a running export coexist. Costs two sidecar files — back up
  // all three, or checkpoint first (see scripts/backup_sqlite.js).
  db.exec('PRAGMA journal_mode = WAL;')
  // NORMAL over FULL: survives a process crash, may lose the last commits in a
  // hard power loss. For an internal tool with nightly backups that trade is
  // worth roughly an order of magnitude on write throughput. Use FULL if a
  // lost transaction means a lost payment.
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  // Wait rather than fail instantly when another writer holds the lock —
  // without this, concurrent writes surface as SQLITE_BUSY to the operator.
  db.exec('PRAGMA busy_timeout = 5000;')

  runMigrations(db, migrationsDir, { logger })
  recoverInterruptedJobs(db, { logger })
  releaseStaleLocks(db, { logger })

  return db
}

/**
 * A stage job left `running` by a killed process would block its pipeline
 * forever: the next run sees "already running" and refuses. Nothing can be
 * running immediately after boot, so cancel them all. Idempotent.
 */
function recoverInterruptedJobs(db, { logger } = {}) {
  if (!tableExists(db, 'stage_job')) return 0
  const { changes } = db
    .prepare(
      `UPDATE stage_job
          SET status = 'cancelled',
              finished_at = ?,
              error_message = COALESCE(error_message, 'cancelled_by_boot_recovery')
        WHERE status = 'running'`
    )
    .run(new Date().toISOString())
  if (changes > 0) logger?.warn?.('recovered_interrupted_jobs', { count: changes })
  return changes
}

/** Same reasoning for advisory locks: a lock row outlives the process holding it. */
function releaseStaleLocks(db, { logger } = {}) {
  if (!tableExists(db, 'advisory_lock')) return 0
  const { changes } = db.prepare('DELETE FROM advisory_lock').run()
  if (changes > 0) logger?.warn?.('released_stale_locks', { count: changes })
  return changes
}

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  )
}

/** Probe for /readyz. Cheap, and fails loudly if the file went away. */
function createDatabaseProbe(db) {
  return () => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()
    return { ok: true, migrations: row?.n ?? 0 }
  }
}

module.exports = { openDatabase, createDatabaseProbe, MIGRATIONS_DIR }
