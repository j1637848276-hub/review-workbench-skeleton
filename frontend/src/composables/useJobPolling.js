import { ref, onUnmounted } from 'vue'

import { batchApi } from '../api'

/**
 * Polls a background stage job until it reaches a terminal state.
 *
 * Polling rather than websockets: one endpoint, no connection lifecycle, no
 * reconnect logic, and it degrades gracefully through any proxy. For a job
 * that takes a minute and is watched by one operator, a websocket is strictly
 * more machinery for the same result.
 *
 * Backs off from 500 ms to 4 s. A fixed 500 ms interval on a ten-minute export
 * is 1,200 requests for information nobody is watching that closely; backing
 * off keeps the first seconds responsive — which is when the operator is
 * actually looking — and then gets out of the way.
 */
export function useJobPolling() {
  const job = ref(null)
  const polling = ref(false)
  const error = ref(null)

  let timer = null
  let cancelled = false

  function stop() {
    cancelled = true
    if (timer) clearTimeout(timer)
    timer = null
    polling.value = false
  }

  /**
   * @param {string} batchId
   * @param {number} jobId
   * @returns {Promise<object>} the terminal job
   */
  function watch(batchId, jobId) {
    stop()
    cancelled = false
    polling.value = true
    error.value = null

    return new Promise((resolve, reject) => {
      let delay = 500

      async function tick() {
        if (cancelled) return
        try {
          const current = await batchApi.job(batchId, jobId)
          job.value = current

          if (current.isTerminal) {
            polling.value = false
            resolve(current)
            return
          }

          delay = Math.min(delay * 1.4, 4000)
          timer = setTimeout(tick, delay)
        } catch (requestError) {
          // A single failed poll is usually a blip, not a dead job. Keep
          // trying at the backed-off interval and surface the error without
          // giving up — abandoning here would leave a running job invisible.
          error.value = requestError.userMessage ?? 'Lost contact with the job.'
          if (requestError.response?.status === 404) {
            polling.value = false
            reject(requestError)
            return
          }
          timer = setTimeout(tick, Math.min(delay * 2, 8000))
        }
      }

      tick()
    })
  }

  // Leaving the page must stop the timer, or every visit leaks one and the tab
  // ends the day making dozens of requests a second.
  onUnmounted(stop)

  return { job, polling, error, watch, stop }
}
