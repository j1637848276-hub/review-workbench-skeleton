import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

import { authApi } from '../api'

/**
 * Session state.
 *
 * Note what is *not* here: the token. It lives in an httpOnly cookie the
 * browser sends automatically and JavaScript cannot read. This store holds
 * only the identity the server told us about, which means a stale store is
 * harmless — the server re-checks the user on every request.
 *
 * `restore()` is the boot path: the cookie may still be valid from a previous
 * visit, so ask the server who we are before deciding to show the login page.
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const restoring = ref(true)

  const isAuthenticated = computed(() => user.value !== null)
  const role = computed(() => user.value?.role ?? null)

  // Mirrors the server's `requireRole`, where admin passes everything. Purely
  // for hiding controls — the server is the authority, and this is convenience.
  const can = computed(() => (...roles) => {
    if (!user.value) return false
    if (user.value.role === 'admin') return true
    return roles.includes(user.value.role)
  })

  // Shared in-flight promise. Several navigations can start before the first
  // probe resolves — a redirect, a deep link, a fast double click — and
  // without this each one fires its own /auth/me.
  let restorePromise = null

  async function restore() {
    if (restorePromise) return restorePromise

    restorePromise = (async () => {
      try {
        const { user: current } = await authApi.me()
        user.value = current
      } catch {
        // A 401 here is the normal "not signed in" case, not an error worth
        // surfacing.
        user.value = null
      } finally {
        restoring.value = false
      }
    })()

    return restorePromise
  }

  async function login(username, password) {
    const { user: signedIn } = await authApi.login(username, password)
    user.value = signedIn
    // Drop the cached probe: the session changed, so a later restore must ask
    // the server again rather than replay the pre-login answer.
    restorePromise = null
    return signedIn
  }

  async function logout() {
    try {
      await authApi.logout()
    } finally {
      // Clear locally even if the request failed — the user asked to sign out
      // and the UI must not keep claiming they are signed in.
      user.value = null
      restorePromise = null
    }
  }

  /** Called by the axios interceptor on a 401. Does not make a request. */
  function clearSession() {
    user.value = null
    restorePromise = null
  }

  return { user, restoring, isAuthenticated, role, can, restore, login, logout, clearSession }
})
