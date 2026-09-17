'use strict'

/**
 * Consistent SQLite backup, plus verification.
 *
 *   node --env-file=.env scripts/backup_sqlite.js
 *   node --env-file=.env scripts/backup_sqlite.js --verify <file>
 *
 * Do not back up a live SQLite database by copying the file. In WAL mode the
 * committed state is spread across `.sqlite`, `.sqlite-wal` and `.sqlite-shm`,
 * so a plain `cp` while the server is running can produce a file that opens
 * fine and is missing the last minutes of work — the worst possible failure,
 * because you only discover it when you restore.
 *
 * `VACUUM INTO` writes a single consistent snapshot while the database stays
 * open and serving. It is also compacted, which usually makes it smaller than
 * the original.
 *
 * A backup you have not restored is a hope, not a backup — hence `--verify`,
 * which opens the file, checks integrity and counts rows. Run it in the same
 * cron job that produces the backup and alert on its exit code.
 */

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const { loadConfig } = require('../lib/config')

const RETAIN_COUNT = Number(process.env.BACKUP_RETAIN_COUNT || 14)

function backup(config) {
  const backupDir = path.join(config.storage.root, 'backups')
  fs.mkdirSync(backupDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(backupDir, `workbench-${stamp}.sqlite`)

  const db = new DatabaseSync(config.storage.databasePath, { readOnly: true })
  try {
    // Must not exist, or VACUUM INTO fails. Better than silently overwriting.
    if (fs.existsSync(target)) throw new Error(`Backup target already exists: ${target}`)
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }

  const { size } = fs.statSync(target)
  process.stdout.write(`Backup written: ${target} (${(size / 1024 / 1024).toFixed(1)} MB)\n`)

  const verdict = verify(target)
  if (!verdict.ok) {
    // Refuse to keep a corrupt backup. Leaving it in place is worse than
    // having none: the next restore picks the newest file and trusts it.
    fs.unlinkSync(target)
    throw new Error(`Backup failed verification and was deleted: ${verdict.reason}`)
  }

  prune(backupDir)
  return target
}

function verify(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'file does not exist' }
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const integrity = db.prepare('PRAGMA integrity_check').get()
    const result = integrity?.integrity_check ?? Object.values(integrity ?? {})[0]
    if (result !== 'ok') return { ok: false, reason: `integrity_check: ${result}` }

    // An empty but structurally valid database passes integrity_check. Assert
    // the schema ledger exists and has rows, which is what "this is one of our
    // databases and it is migrated" actually means.
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()
    if (n === 0) return { ok: false, reason: 'no migrations recorded — wrong or empty database' }

    const counts = {}
    for (const table of ['user', 'batch', 'document', 'audit_log']) {
      counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    }
    process.stdout.write(`Verified ${path.basename(file)}: ${JSON.stringify(counts)}\n`)
    return { ok: true, counts }
  } catch (error) {
    return { ok: false, reason: error.message }
  } finally {
    db?.close()
  }
}

function prune(backupDir) {
  const files = fs
    .readdirSync(backupDir)
    .filter((name) => /^workbench-.*\.sqlite$/.test(name))
    .sort()
    .reverse()
  for (const stale of files.slice(RETAIN_COUNT)) {
    fs.unlinkSync(path.join(backupDir, stale))
    process.stdout.write(`Pruned old backup: ${stale}\n`)
  }
}

function main() {
  const config = loadConfig({ projectRoot: path.join(__dirname, '..') })
  const verifyIndex = process.argv.indexOf('--verify')

  if (verifyIndex !== -1) {
    const file = process.argv[verifyIndex + 1]
    if (!file) throw new Error('Usage: --verify <file>')
    const verdict = verify(file)
    if (!verdict.ok) {
      process.stderr.write(`FAILED: ${verdict.reason}\n`)
      process.exit(1)
    }
    return
  }

  backup(config)
}

main()
