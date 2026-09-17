'use strict'

/**
 * All SQL touching `user` lives here.
 *
 * The repository layer exists for two reasons that pay off immediately:
 *
 *  - Services never see SQL, so moving from SQLite to Postgres is a change to
 *    this directory and nothing else.
 *  - Row shape is converted at exactly one boundary. The database speaks
 *    `snake_case` and `0|1`; the rest of the application speaks `camelCase`
 *    and booleans. Without a single mapping point, `is_active` and `isActive`
 *    both end up in use and the bug is a permission check that never fires.
 *
 * Never return a raw row, and never return `password_hash` from anything but
 * the verification path.
 */

const { ConflictError, NotFoundError } = require('../lib/errors')

function toUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    displayName: row.display_name,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  }
}

function createUserRepository({ db }) {
  if (!db) throw new Error('db is required')

  // Prepared once per process. node:sqlite caches the compiled plan, which
  // matters on the auth path — it runs on every single request.
  const statements = {
    byId: db.prepare('SELECT * FROM user WHERE id = ?'),
    byUsername: db.prepare('SELECT * FROM user WHERE username = ?'),
    list: db.prepare('SELECT * FROM user ORDER BY username'),
    insert: db.prepare(`
      INSERT INTO user (username, password_hash, role, display_name, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updateRole: db.prepare('UPDATE user SET role = ?, updated_at = ? WHERE id = ?'),
    updateActive: db.prepare('UPDATE user SET is_active = ?, updated_at = ? WHERE id = ?'),
    updatePassword: db.prepare('UPDATE user SET password_hash = ?, updated_at = ? WHERE id = ?'),
    touchLogin: db.prepare('UPDATE user SET last_login_at = ? WHERE id = ?'),
    countAdmins: db.prepare(
      "SELECT COUNT(*) AS n FROM user WHERE role = 'admin' AND is_active = 1"
    ),
  }

  function findById(id) {
    return toUser(statements.byId.get(Number(id)))
  }

  function findByUsername(username) {
    return toUser(statements.byUsername.get(String(username)))
  }

  /** The only method that returns the hash. Used by the login path alone. */
  function findCredentialsByUsername(username) {
    const row = statements.byUsername.get(String(username))
    if (!row) return null
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      isActive: row.is_active === 1,
    }
  }

  function list() {
    return statements.list.all().map(toUser)
  }

  function create({ username, passwordHash, role, displayName = null, isActive = true }) {
    const now = new Date().toISOString()
    try {
      const { lastInsertRowid } = statements.insert.run(
        String(username),
        String(passwordHash),
        String(role),
        displayName,
        isActive ? 1 : 0,
        now,
        now
      )
      return findById(lastInsertRowid)
    } catch (error) {
      // Turn the UNIQUE violation into the 409 the API promises, rather than
      // letting a driver message reach the client as a 500.
      if (String(error?.message || '').includes('UNIQUE')) {
        throw new ConflictError(`User "${username}" already exists`, { code: 'user_exists' })
      }
      throw error
    }
  }

  function setRole(id, role) {
    guardLastAdmin({ id, nextRole: role })
    const { changes } = statements.updateRole.run(
      String(role),
      new Date().toISOString(),
      Number(id)
    )
    if (changes === 0) throw new NotFoundError(`User ${id} not found`)
    return findById(id)
  }

  function setActive(id, isActive) {
    if (!isActive) guardLastAdmin({ id, deactivating: true })
    const { changes } = statements.updateActive.run(
      isActive ? 1 : 0,
      new Date().toISOString(),
      Number(id)
    )
    if (changes === 0) throw new NotFoundError(`User ${id} not found`)
    return findById(id)
  }

  function setPasswordHash(id, passwordHash) {
    const { changes } = statements.updatePassword.run(
      String(passwordHash),
      new Date().toISOString(),
      Number(id)
    )
    if (changes === 0) throw new NotFoundError(`User ${id} not found`)
    return findById(id)
  }

  function recordLogin(id) {
    statements.touchLogin.run(new Date().toISOString(), Number(id))
  }

  /**
   * Refuse to remove the last admin. Otherwise the plainly reachable sequence
   * "demote yourself, then discover nobody can restore it" ends with someone
   * editing the database by hand.
   */
  function guardLastAdmin({ id, nextRole = null, deactivating = false }) {
    const current = findById(id)
    if (!current || current.role !== 'admin' || !current.isActive) return
    const losingAdmin = deactivating || (nextRole && nextRole !== 'admin')
    if (!losingAdmin) return
    if (statements.countAdmins.get().n <= 1) {
      throw new ConflictError('Cannot remove the last active admin.', { code: 'last_admin' })
    }
  }

  function countActiveAdmins() {
    return statements.countAdmins.get().n
  }

  return {
    findById,
    findByUsername,
    findCredentialsByUsername,
    list,
    create,
    setRole,
    setActive,
    setPasswordHash,
    recordLogin,
    countActiveAdmins,
  }
}

module.exports = { createUserRepository }
