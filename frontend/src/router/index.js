import { createRouter, createWebHistory } from 'vue-router'

import { useAuthStore } from '../stores/auth'

/**
 * Routes are lazy except the shell and login, so the initial bundle is the
 * login screen and nothing else.
 *
 * `meta.roles` mirrors the server's role gating. It is convenience only — it
 * keeps a viewer from landing on a page where every button 403s. The server is
 * the authority, and it re-checks on every request.
 */
const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: () => import('../layouts/AppShell.vue'),
    children: [
      { path: '', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
      {
        path: 'batches/:id',
        name: 'batch',
        component: () => import('../views/BatchDetailView.vue'),
        props: true,
      },
      {
        path: 'review',
        name: 'review',
        component: () => import('../views/ReviewView.vue'),
        meta: { roles: ['reviewer'] },
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('../views/AuditView.vue'),
        meta: { roles: [] }, // admin only — see the guard below
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (to, from, saved) => saved ?? { top: 0 },
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  // On a hard reload the cookie may still be valid, so ask the server before
  // deciding. Without this, every refresh bounces the user to login and back.
  if (auth.restoring) await auth.restore()

  if (to.meta.public) {
    // Already signed in and heading to login: go where they were going.
    return auth.isAuthenticated ? { name: 'dashboard' } : true
  }

  if (!auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (Array.isArray(to.meta.roles) && !auth.can(...to.meta.roles)) {
    // Back to the dashboard, not to login: they are signed in, just not
    // allowed here. Sending them to login would look like a session failure.
    return { name: 'dashboard' }
  }

  return true
})

export default router
