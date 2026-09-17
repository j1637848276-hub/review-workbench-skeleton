'use strict'

/**
 * Run a function inside a transaction, nesting safely.
 *
 * SQLite has no nested `BEGIN`. Without this helper, a service that wraps its
 * writes in a transaction breaks the moment it is called from another service
 * that already opened one — the inner `BEGIN` throws, or worse, the inner
 * `COMMIT` commits the *outer* work early, publishing a half-finished change.
 * That bug is subtle, load-dependent, and expensive to find.
 *
 * So: if a transaction is already open, use a SAVEPOINT; otherwise a plain
 * transaction. Callers stop caring who started what.
 *
 *   runInTransaction(db, () => {
 *     repo.insertBatch(batch)
 *     repo.insertDocuments(documents)   // may itself use this helper
 *   })
 *
 * `mode: 'BEGIN IMMEDIATE'` takes the write lock up front. Use it when the
 * transaction reads a value and then writes based on it — with a deferred
 * `BEGIN`, two such transactions can both read, then one fails on upgrade.
 */

function sanitizeSavepointName(value) {
  // Interpolated into SQL, so it must be an identifier and nothing else.
  return String(value || 'nested').replace(/[^A-Za-z0-9_]/g, '_')
}

function runInTransaction(db, action, { mode = 'BEGIN', savepointName = 'nested' } = {}) {
  if (!db || typeof action !== 'function') throw new Error('db and action are required')

  if (db.isTransaction) {
    const name = sanitizeSavepointName(savepointName)
    db.exec(`SAVEPOINT ${name}`)
    try {
      const result = action()
      db.exec(`RELEASE SAVEPOINT ${name}`)
      return result
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${name}`)
      } finally {
        // Roll back *and* release, or the savepoint stays on the stack and the
        // outer transaction can never commit.
        try {
          db.exec(`RELEASE SAVEPOINT ${name}`)
        } catch {
          // Best effort; the original error is the one that matters.
        }
      }
      throw error
    }
  }

  db.exec(mode)
  try {
    const result = action()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Best effort; rethrow the original.
    }
    throw error
  }
}

module.exports = { runInTransaction }
