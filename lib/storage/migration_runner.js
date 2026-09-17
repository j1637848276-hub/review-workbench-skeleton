'use strict'

/**
 * Forward-only versioned migrations, applied at boot.
 *
 * Files live in `migrations/` and are named `NNNN_description.sql` or
 * `NNNN_description.js`. Applied versions are recorded in `schema_migrations`,
 * so startup is idempotent and a fresh checkout reaches the same schema as a
 * two-year-old deployment by running the same list.
 *
 * Design decisions worth knowing before you change them:
 *
 *  - Each migration runs inside its own transaction and the version row is
 *    inserted in the same transaction. A migration cannot half-apply, and the
 *    ledger cannot disagree with the schema.
 *  - A failure aborts the boot. Serving traffic against a half-migrated schema
 *    corrupts data in ways that are expensive to unpick; refusing to start is
 *    an outage you can fix in minutes.
 *  - No `down` migrations. In practice nobody tests them, and a rollback that
 *    has never been exercised is worse than no rollback. Roll forward: restore
 *    a backup, or add `0043_undo_0042`.
 *  - `.sql` for plain DDL, `.js` for anything needing to read data (a
 *    backfill, a conditional column add). A `.js` migration exports a single
 *    function receiving the open database handle.
 *
 * Never edit an applied migration. It will not re-run, so your environment and
 * everyone else's silently diverge. Add the next number instead.
 */

const fs = require('node:fs')
const path = require('node:path')

const { logger: defaultLogger } = require('../request_logger')

const MIGRATION_FILE_RE = /^\d{4}_.+\.(sql|js)$/

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
}

function listMigrationFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MIGRATION_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort() // zero-padded numeric prefix makes lexical sort the right order
}

function getAppliedVersions(db) {
  return new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version))
}

function runMigrationFile(db, fullPath) {
  if (fullPath.endsWith('.sql')) {
    db.exec(fs.readFileSync(fullPath, 'utf8'))
    return
  }
  const resolved = require.resolve(fullPath)
  delete require.cache[resolved] // so tests can re-run a runner in one process
  const migration = require(resolved)
  if (typeof migration !== 'function') {
    throw new Error(`JS migration must export a function: ${path.basename(fullPath)}`)
  }
  migration(db)
}

function rollback(db) {
  try {
    db.exec('ROLLBACK')
  } catch {
    // Best effort: the transaction may already be gone. The thrown migration
    // error is what matters, so do not mask it with a rollback failure.
  }
}

function runMigrations(db, dir, { logger = defaultLogger } = {}) {
  ensureMigrationTable(db)
  const applied = getAppliedVersions(db)
  const pending = listMigrationFiles(dir).filter(
    (file) => !applied.has(path.basename(file, path.extname(file)))
  )

  if (pending.length === 0) return { applied: [] }
  logger?.info?.('migrations_pending', { count: pending.length })

  const appliedNow = []
  for (const fileName of pending) {
    const version = path.basename(fileName, path.extname(fileName))
    const fullPath = path.resolve(dir, fileName)
    const startedAt = Date.now()
    try {
      db.exec('BEGIN')
      runMigrationFile(db, fullPath)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString()
      )
      db.exec('COMMIT')
      logger?.info?.('migration_applied', { version, ms: Date.now() - startedAt })
      appliedNow.push(version)
    } catch (cause) {
      rollback(db)
      const error = new Error(
        `Migration ${version} failed: ${cause instanceof Error ? cause.message : String(cause)}`
      )
      error.name = 'MigrationError'
      error.version = version
      error.cause = cause
      throw error
    }
  }

  return { applied: appliedNow }
}

module.exports = { runMigrations, listMigrationFiles }
