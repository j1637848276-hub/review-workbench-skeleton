import api from './client'

/**
 * Every endpoint the SPA calls, in one file.
 *
 * Kept as a flat module rather than scattered `axios.get` calls through
 * components, for two reasons: the full API surface the UI depends on is
 * readable in one screen, and when a route changes there is exactly one place
 * to update. Split this per-domain (`api/batches.js`, `api/documents.js`) once
 * it outgrows a screen.
 */

export const authApi = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  logout: () => api.post('/auth/logout'),
  // skipAuthRedirect: a 401 here answers "am I signed in?" with "no". It must
  // not trigger the interceptor's redirect-to-login — see client.js.
  me: () => api.get('/auth/me', { skipAuthRedirect: true }),
  changePassword: (currentPassword, newPassword) =>
    api.post('/auth/password', { currentPassword, newPassword }),
}

export const batchApi = {
  list: (params = {}) => api.get('/batches', { params }),
  create: (payload) => api.post('/batches', payload),
  get: (id, params = {}) => api.get(`/batches/${encodeURIComponent(id)}`, { params }),
  remove: (id) => api.delete(`/batches/${encodeURIComponent(id)}`),

  uploadDocuments: (id, files, onProgress) => {
    const form = new FormData()
    for (const file of files) form.append('files', file)
    return api.post(`/batches/${encodeURIComponent(id)}/documents`, form, {
      // Real progress, not a fake spinner. A 300-file upload takes minutes and
      // an operator needs to know it is moving.
      onUploadProgress: (event) => {
        if (onProgress && event.total) onProgress(Math.round((event.loaded / event.total) * 100))
      },
    })
  },

  // The Idempotency-Key header is what makes a double-clicked button start one
  // job instead of two. Generated per user action, not per request, so an
  // automatic retry reuses it.
  recognize: (id, idempotencyKey) =>
    api.post(`/batches/${encodeURIComponent(id)}/stages/recognize`, null, {
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  export: (id, planId, idempotencyKey) =>
    api.post(
      `/batches/${encodeURIComponent(id)}/export`,
      { planId },
      { headers: { 'Idempotency-Key': idempotencyKey } }
    ),

  job: (id, jobId) => api.get(`/batches/${encodeURIComponent(id)}/jobs/${jobId}`),
  jobs: (id) => api.get(`/batches/${encodeURIComponent(id)}/jobs`),

  lock: (id) => api.post(`/batches/${encodeURIComponent(id)}/lock`),
  unlock: (id) => api.post(`/batches/${encodeURIComponent(id)}/unlock`),
}

export const documentApi = {
  queue: (params = {}) => api.get('/documents/queue', { params }),
  get: (id) => api.get(`/documents/${encodeURIComponent(id)}`),
  // A URL, not a request: bound directly to <img src>. The cookie authorises
  // it the same as any other request.
  fileUrl: (id) => `/api/documents/${encodeURIComponent(id)}/file`,
  correct: (id, corrections, reason) =>
    api.patch(`/documents/${encodeURIComponent(id)}/fields`, { corrections, reason }),
  review: (id, decision) => api.post(`/documents/${encodeURIComponent(id)}/review`, { decision }),
}

export const adminApi = {
  users: () => api.get('/admin/users'),
  createUser: (payload) => api.post('/admin/users', payload),
  updateUser: (id, payload) => api.patch(`/admin/users/${id}`, payload),
  audit: (params = {}) => api.get('/admin/audit', { params }),
  auditActions: () => api.get('/admin/audit/actions'),
}

/** Correlates a user action with the requests it produces. */
export function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
