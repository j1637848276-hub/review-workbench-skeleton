import axios from 'axios'

import router from '../router'

/**
 * The single axios instance. Everything in `src/api/` goes through it.
 *
 * Three behaviours are wired in here, and each exists because of a specific
 * failure that is invisible in development:
 *
 *  1. `withCredentials` — the session is an httpOnly cookie, so without this
 *     every request is anonymous.
 *  2. A longer timeout for uploads and downloads. The 30s default kills a
 *     multi-file upload on an office uplink mid-transfer, and the browser
 *     reports a bare "Network Error" with nothing in the server log, because
 *     the request never finished arriving.
 *  3. Deploy detection via `X-App-Boot`. This app stays open for days, so
 *     after a deploy the tab keeps running the old bundle and reports bugs you
 *     already fixed. See `bootId` below.
 */

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 30_000,
})

// ------------------------------------------------------------------ uploads

api.interceptors.request.use((config) => {
  const isUpload = typeof FormData !== 'undefined' && config.data instanceof FormData
  const isDownload = config.responseType === 'blob'
  if (isUpload || isDownload) config.timeout = 5 * 60 * 1000
  return config
})

// -------------------------------------------------------- deploy detection

let bootId = ''
const bootListeners = new Set()

/** Subscribe to "the server restarted with new code". Returns an unsubscribe. */
export function onAppUpdated(listener) {
  bootListeners.add(listener)
  return () => bootListeners.delete(listener)
}

function noteBootId(value) {
  const next = String(value || '')
  if (!next) return
  if (!bootId) {
    bootId = next
    return
  }
  if (bootId !== next) {
    bootId = next
    for (const listener of bootListeners) listener()
  }
}

/**
 * The passive check above only fires when a request happens. A user who spends
 * twenty minutes zooming into one document makes no requests at all, so poll
 * the unauthenticated, instant `/readyz` when the tab becomes visible again.
 */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    fetch('/readyz', { cache: 'no-store', credentials: 'same-origin' })
      .then((response) => noteBootId(response.headers.get('x-app-boot')))
      .catch(() => {
        // A failed probe is fine — the next API call will notice.
      })
  })
}

// ------------------------------------------------------------- unwrapping

/**
 * Unwraps `response.data`, so callers get the payload rather than an axios
 * envelope. Errors are re-shaped to carry the server's machine `code` and the
 * `requestId`, which is the single most useful thing to put in front of a user
 * when something fails: it maps to exactly one server log line.
 */
api.interceptors.response.use(
  (response) => {
    noteBootId(response.headers?.['x-app-boot'])
    return response.data
  },
  async (error) => {
    const { status, data, headers } = error.response ?? {}
    error.code = data?.code ?? (error.code === 'ECONNABORTED' ? 'timeout' : 'network_error')
    error.requestId = data?.requestId ?? headers?.['x-request-id'] ?? null
    error.userMessage = data?.error ?? friendlyMessage(error, status)

    if (status === 401) {
      // The session is gone, not merely this request. Clear local state and
      // send the user to login, preserving where they were.
      //
      // Imported dynamically to break a cycle: the auth store imports `api`,
      // which imports this file. A static import here would be a circular
      // dependency. The bundler warns that the dynamic import cannot be split
      // into its own chunk, which is fine — breaking the cycle is the point.
      const { useAuthStore } = await import('../stores/auth')
      useAuthStore().clearSession()

      // `skipAuthRedirect` requests opt out of the redirect. `GET /auth/me`
      // sets it: a 401 there is the expected answer to "am I signed in?", not
      // a session that just expired. Without the opt-out, the boot-time probe
      // redirects from inside the router guard that triggered it, and the
      // guard re-runs on the new navigation — an infinite redirect loop that
      // renders a blank page and hammers the server.
      if (error.config?.skipAuthRedirect) return Promise.reject(error)

      const current = router.currentRoute.value
      if (current.name !== 'login') {
        await router.push({ name: 'login', query: { redirect: current.fullPath } })
      }
    }

    return Promise.reject(error)
  }
)

function friendlyMessage(error, status) {
  if (error.code === 'timeout') return 'The request took too long. Please try again.'
  if (!status) return 'Cannot reach the server. Check your connection.'
  if (status === 403) return 'You do not have permission to do that.'
  if (status >= 500) return 'The server hit an unexpected error.'
  return 'Something went wrong.'
}

export default api
