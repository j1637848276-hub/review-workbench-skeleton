'use strict'

/**
 * Admin surface: user management and the audit log reader.
 *
 *   GET    /api/admin/users              list
 *   POST   /api/admin/users              create
 *   PATCH  /api/admin/users/:id          role / active / password reset
 *   GET    /api/admin/audit              search the audit log
 *   GET    /api/admin/audit/actions      distinct actions, for the filter UI
 *
 * Every route here is admin-only. Note that the audit log is readable but has
 * no write or delete endpoint at all — entries are produced by the middleware
 * and nothing else, which is what makes the trail worth having.
 */

const { BadRequestError } = require('../lib/errors')
const { asyncRoute } = require('./auth_routes')

const ASSIGNABLE_ROLES = Object.freeze(['admin', 'reviewer', 'viewer'])

function registerAdminRoutes({
  app,
  authenticate,
  requireRole,
  authService,
  userRepository,
  auditLogRepository,
}) {
  const adminOnly = [authenticate, requireRole([], { allowAdmin: true })]

  app.get(
    '/api/admin/users',
    ...adminOnly,
    asyncRoute(async (_req, res) => {
      res.json({ users: userRepository.list() })
    })
  )

  app.post(
    '/api/admin/users',
    ...adminOnly,
    asyncRoute(async (req, res) => {
      const { username, password, role, displayName = null } = req.body ?? {}
      if (!ASSIGNABLE_ROLES.includes(role)) {
        throw new BadRequestError(`role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`, {
          code: 'invalid_role',
        })
      }
      res.status(201).json(await authService.createUser({ username, password, role, displayName }))
    })
  )

  app.patch(
    '/api/admin/users/:id',
    ...adminOnly,
    asyncRoute(async (req, res) => {
      const userId = Number(req.params.id)
      const { role, isActive, newPassword } = req.body ?? {}

      // Guard self-demotion and self-deactivation before touching anything.
      // The repository refuses to remove the *last* admin; this refuses the
      // much more common "I locked myself out" version.
      if (userId === req.user.id && role && role !== 'admin') {
        throw new BadRequestError('Use another admin account to change your own role.', {
          code: 'cannot_demote_self',
        })
      }
      if (userId === req.user.id && isActive === false) {
        throw new BadRequestError('You cannot deactivate your own account.', {
          code: 'cannot_deactivate_self',
        })
      }

      let user = userRepository.findById(userId)
      if (role !== undefined) {
        if (!ASSIGNABLE_ROLES.includes(role)) {
          throw new BadRequestError(`role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`, {
            code: 'invalid_role',
          })
        }
        user = userRepository.setRole(userId, role)
      }
      if (isActive !== undefined) user = userRepository.setActive(userId, Boolean(isActive))
      if (newPassword) {
        // requireCurrent: false — an admin reset has no current password to
        // offer. This is why the route is admin-only and audited.
        user = await authService.changePassword({ userId, newPassword, requireCurrent: false })
      }

      res.json(user)
    })
  )

  app.get(
    '/api/admin/audit',
    ...adminOnly,
    asyncRoute(async (req, res) => {
      const { action, userId, resourceType, resourceId, from, to, limit, offset } = req.query
      res.json(
        auditLogRepository.search({
          action,
          userId,
          resourceType,
          resourceId,
          from,
          to,
          limit,
          offset,
        })
      )
    })
  )

  app.get(
    '/api/admin/audit/actions',
    ...adminOnly,
    asyncRoute(async (_req, res) => {
      res.json({ actions: auditLogRepository.listActions() })
    })
  )
}

module.exports = { registerAdminRoutes, ASSIGNABLE_ROLES }
