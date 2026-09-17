'use strict'

/**
 * Migration runner behaviour.
 *
 * The transactional test is the important one. "A failed migration leaves the
 * schema half-applied" is the bug that turns a bad deploy into a data-recovery
 * exercise, and it is invisible until it happens.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')

const { runMigrations } = require('../lib/storage/migration_runner')
const { openDatabase, MIGRATIONS_DIR } = require('../lib/storage/database')

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

function tempMigrationDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'))
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents)
  }
  return dir
}

test('migrations apply in order and record their versions', async (t) => {
  const dir = tempMigrationDir({
    '0001_first.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
    '0002_second.sql': 'CREATE TABLE b (id INTEGER PRIMARY KEY);',
    // A dotfile and a badly named file must both be ignored, or an editor
    // swap file breaks the boot.
    'notes.txt': 'ignored',
    '.0003_hidden.sql': 'CREATE TABLE never (id INTEGER);',
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())

  const { applied } = runMigrations(db, dir, { logger: silentLogger })
  assert.deepEqual(applied, ['0001_first', '0002_second'])

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name)
  assert.ok(tables.includes('a') && tables.includes('b'))
  assert.ok(!tables.includes('never'))
})

test('re-running is a no-op', async (t) => {
  const dir = tempMigrationDir({ '0001_first.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);' })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())

  runMigrations(db, dir, { logger: silentLogger })
  const second = runMigrations(db, dir, { logger: silentLogger })
  assert.deepEqual(second.applied, [], 'an applied migration must not run twice')
})

test('a failing migration rolls back entirely and is not recorded', async (t) => {
  const dir = tempMigrationDir({
    '0001_ok.sql': 'CREATE TABLE good (id INTEGER PRIMARY KEY);',
    // Valid first statement, invalid second: the half that succeeded must be
    // rolled back with the half that failed.
    '0002_broken.sql': 'CREATE TABLE half (id INTEGER); SELECT this_is_not_valid_sql(;',
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())

  assert.throws(
    () => runMigrations(db, dir, { logger: silentLogger }),
    /Migration 0002_broken failed/
  )

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name)
  assert.ok(tables.includes('good'), 'the earlier migration stays applied')
  assert.ok(!tables.includes('half'), 'the failed migration must leave nothing behind')

  const versions = db
    .prepare('SELECT version FROM schema_migrations')
    .all()
    .map((r) => r.version)
  assert.deepEqual(versions, ['0001_ok'], 'a failed migration must not be recorded as applied')
})

test('a JS migration that does not export a function fails loudly', async (t) => {
  const dir = tempMigrationDir({ '0001_bad.js': 'module.exports = { not: "a function" }' })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())

  assert.throws(() => runMigrations(db, dir, { logger: silentLogger }), /must export a function/)
})

test('the real migration set applies to an empty database', async (t) => {
  // Guards the case a unit test cannot: that the checked-in migrations are
  // mutually consistent and produce the schema the repositories expect.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-'))
  const db = openDatabase({ dbPath: path.join(dir, 'test.sqlite'), logger: silentLogger })

  // Close, then delete, in one hook. node:test runs `after` hooks in the order
  // they were registered, so two separate hooks would delete the directory
  // first — and on Windows that fails with EPERM because the database file is
  // still open.
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name)

  for (const expected of [
    'advisory_lock',
    'audit_log',
    'batch',
    'document',
    'document_field',
    'field_history',
    'stage_job',
    'user',
  ]) {
    assert.ok(tables.includes(expected), `missing table: ${expected}`)
  }

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,
    fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_/.test(name)).length,
    'every migration file should be recorded'
  )
})

test('boot recovery cancels jobs left running by a dead process', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-'))
  const dbPath = path.join(dir, 'test.sqlite')

  const first = openDatabase({ dbPath, logger: silentLogger })
  first
    .prepare(
      'INSERT INTO batch (id, label, business_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run('b', 'x', '2026-01-01', 'now', 'now')
  first
    .prepare(
      "INSERT INTO stage_job (batch_id, stage, status, created_at) VALUES ('b', 'recognize', 'running', 'now')"
    )
    .run()
  first.close() // simulate a kill mid-stage

  const second = openDatabase({ dbPath, logger: silentLogger })
  t.after(() => {
    second.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const job = second.prepare('SELECT status, error_message FROM stage_job LIMIT 1').get()
  assert.equal(job.status, 'cancelled', 'a stale running job would block the batch forever')
  assert.match(job.error_message, /boot_recovery/)
})
