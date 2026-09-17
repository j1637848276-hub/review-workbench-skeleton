'use strict'

/**
 * Login, session and user administration.
 *
 * The rules worth keeping when you adapt this:
 *
 *  - A failed login says "Invalid username or password" and nothing else.
 *    Distinguishing "no such user" from "wrong password" hands an attacker a
 *    free account enumeration oracle.
 *  - Verify the password even when the user does not exist. Skipping the hash
 *    on a missing account makes the response measurably faster, which is the
 *    same oracle by a different route.
 *  - Bootstrap admin creation happens once, at boot, and only into an empty
 *    user table. It must never overwrite an existing account: an env var that
 *    silently resets the admin password on every deploy is a back door.
 */

const { UnauthorizedError, BadRequestError } = require('../lib/errors')
const {
  hashPassword,
  verifyPassword,
  needsRehash,
  MIN_PASSWORD_LENGTH,
} = require('../lib/auth/password')
const { generateToken } = require('../lib/auth/jwt_middleware')
const { logger } = require('../lib/request_logger')

/** Hashing this on a miss keeps the failure path the same cost as a real one. */
const DUMMY_HASH =
  'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

function createAuthService({ userRepository, config }) {
  if (!userRepository) throw new Error('userRepository is required')

  async function login({ username, password }) {
    if (!username || !password) {
      throw new BadRequestError('Username and password are required', {
        code: 'missing_credentials',
      })
    }

    const credentials = userRepository.findCredentialsByUsername(username)
    const ok = await verifyPassword(password, credentials?.passwordHash ?? DUMMY_HASH)

    if (!credentials || !ok || !credentials.isActive) {
      // One message, one code, whatever went wrong.
      logger.warn('login_failed', { username: String(username).slice(0, 64) })
      throw new UnauthorizedError('Invalid username or password', { code: 'invalid_credentials' })
    }

    // Opportunistic upgrade: when hashing parameters get stronger, accounts
    // migrate as their owners sign in, with no reset email and no flag day.
    if (needsRehash(credentials.passwordHash)) {
      try {
        userRepository.setPasswordHash(credentials.id, await hashPassword(password))
        logger.info('password_rehashed', { userId: credentials.id })
      } catch (error) {
        // A failed upgrade must not fail the login.
        logger.warn('password_rehash_failed', { err: error, userId: credentials.id })
      }
    }

    userRepository.recordLogin(credentials.id)
    const user = userRepository.findById(credentials.id)

    return {
      user,
      token: generateToken(user, {
        secret: config.auth.jwtSecret,
        expiresIn: config.auth.jwtExpiresIn,
      }),
    }
  }

  /** The `authenticateToken` middleware calls this on every request. */
  async function getUserById(id) {
    return userRepository.findById(id)
  }

  async function createUser({ username, password, role, displayName = null }) {
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(String(username || ''))) {
      throw new BadRequestError(
        'Username must be 3-64 characters, letters, digits, dot, underscore or dash.',
        { code: 'invalid_username' }
      )
    }
    if (String(password || '').length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, {
        code: 'weak_password',
      })
    }
    return userRepository.create({
      username,
      passwordHash: await hashPassword(password),
      role,
      displayName,
    })
  }

  async function changePassword({ userId, currentPassword, newPassword, requireCurrent = true }) {
    const credentials = userRepository.findCredentialsByUsername(
      userRepository.findById(userId)?.username ?? ''
    )
    if (!credentials) throw new UnauthorizedError('Unknown user', { code: 'unknown_user' })

    // An admin resetting someone else's password has no current password to
    // supply; a user changing their own must prove they hold the session.
    if (requireCurrent && !(await verifyPassword(currentPassword, credentials.passwordHash))) {
      throw new UnauthorizedError('Current password is incorrect', { code: 'invalid_credentials' })
    }
    if (String(newPassword || '').length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, {
        code: 'weak_password',
      })
    }

    return userRepository.setPasswordHash(userId, await hashPassword(newPassword))
  }

  /**
   * Creates the first admin so a fresh deployment is reachable. Runs only when
   * the user table is empty.
   */
  async function ensureBootstrapAdmin() {
    if (userRepository.list().length > 0) return null

    const { bootstrapAdminUsername, bootstrapAdminPassword } = config.auth
    if (!bootstrapAdminPassword) {
      logger.warn('bootstrap_admin_skipped', {
        reason: 'BOOTSTRAP_ADMIN_PASSWORD is empty — create the first admin with: npm run users',
      })
      return null
    }

    const user = await createUser({
      username: bootstrapAdminUsername,
      password: bootstrapAdminPassword,
      role: 'admin',
      displayName: 'Bootstrap admin',
    })
    logger.warn('bootstrap_admin_created', {
      username: user.username,
      reminder: 'Change this password and clear BOOTSTRAP_ADMIN_PASSWORD from .env.',
    })
    return user
  }

  return { login, getUserById, createUser, changePassword, ensureBootstrapAdmin }
}

module.exports = { createAuthService }
