'use strict'

/**
 * Apply pending migrations without starting the server.
 *
 *   node --env-file=.env scripts/migrate.js
 *   node --env-file=.env scripts/migrate.js --status
 *
 * The server migrates on boot anyway, so this exists for the cases where that
 * is not good enough: running migrations as a separate deploy step before the
 * new code rolls out, and checking what a database is actually at without
 * starting anything.
 */

const path = require('node:path')

const { loadConfig } = require('../lib/config')
const { openDatabase, MIGRATIONS_DIR } = require('../lib/storage/database')
const { listMigrationFiles } = require('../lib/storage/migration_runner')
const { logger } = require('../lib/request_logger')

function main() {
  const config = loadConfig({ projectRoot: path.join(__dirname, '..') })
  const statusOnly = process.argv.includes('--status')

  if (statusOnly) {
    // Read-only path: openDatabase would apply migrations, which is exactly
    // what --status must not do.
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(config.storage.databasePath, { readOnly: true })
    const applied = new Set(
      db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => row.version)
    )
    const all = listMigrationFiles(MIGRATIONS_DIR).map((file) =>
      path.basename(file, path.extname(file))
    )
    for (const version of all) {
      process.stdout.write(`${applied.has(version) ? '[applied]' : '[pending]'} ${version}\n`)
    }
    process.stdout.write(`\n${applied.size}/${all.length} applied\n`)
    db.close()
    return
  }

  // openDatabase runs the migrations and the boot recovery.
  const db = openDatabase({ dbPath: config.storage.databasePath, logger })
  db.close()
  process.stdout.write('Migrations up to date.\n')
}

main()
