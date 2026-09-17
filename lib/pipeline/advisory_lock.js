'use strict'

/**
 * Cooperative locks so two runs of the same stage cannot overlap.
 *
 * The problem this solves is mundane and happens in every deployment: an
 * operator clicks "Recognize" twice, or a scheduled run fires while a manual
 * one is still going. Both runs read the same pending documents and both write
 * results; the surviving state belongs to neither. An `INSERT` against a
 * primary key is the cheapest reliable way to make the second attempt lose.
 *
 * Locks carry an expiry because the alternative is worse. If a process is
 * SIGKILLed mid-stage, its lock row survives and the batch is wedged until
 * someone finds the table. Boot recovery clears rows (see
 * lib/storage/database.js), but a long-lived process that hangs internally
 * never reboots — the TTL is what covers that. Set it above your realistic
 * worst-case stage duration, or a slow run will have its lock stolen while
 * still working.
 */

const { ConflictError } = require('../errors')

const DEFAULT_TTL_MS = 30 * 60 * 1000

function createLockManager({ db, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!db) throw new Error('db is required')

  function purgeExpired(nowIso) {
    db.prepare('DELETE FROM advisory_lock WHERE expires_at <= ?').run(nowIso)
  }

  /**
   * @returns {{ lockKey: string, release: () => void }}
   * @throws {ConflictError} when someone else holds it — surfaced to the SPA
   *         as 409 so it can say "already running" instead of "error".
   */
  function acquire(lockKey, { holder = `pid:${process.pid}` } = {}) {
    const now = new Date()
    const nowIso = now.toISOString()
    purgeExpired(nowIso)

    try {
      db.prepare(
        'INSERT INTO advisory_lock (lock_key, acquired_at, holder, expires_at) VALUES (?, ?, ?, ?)'
      ).run(lockKey, nowIso, holder, new Date(now.getTime() + ttlMs).toISOString())
    } catch {
      // Primary-key collision. Report who holds it: "locked" with no owner is
      // the kind of message that generates a support ticket.
      const current = db
        .prepare('SELECT holder, acquired_at FROM advisory_lock WHERE lock_key = ?')
        .get(lockKey)
      throw new ConflictError(
        `"${lockKey}" is already running (holder ${current?.holder ?? 'unknown'}, since ${current?.acquired_at ?? 'unknown'}).`,
        { code: 'already_running', details: { lockKey, holder: current?.holder } }
      )
    }

    let released = false
    return {
      lockKey,
      release() {
        if (released) return
        released = true
        db.prepare('DELETE FROM advisory_lock WHERE lock_key = ?').run(lockKey)
      },
    }
  }

  /**
   * Run `action` while holding the lock. Always prefer this over acquire():
   * the `finally` is the whole point, and a hand-rolled try/finally is exactly
   * what gets forgotten on the error path that only fires in production.
   */
  async function withLock(lockKey, action, options = {}) {
    const lock = acquire(lockKey, options)
    try {
      return await action()
    } finally {
      lock.release()
    }
  }

  return { acquire, withLock }
}

module.exports = { createLockManager, DEFAULT_TTL_MS }
