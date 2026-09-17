'use strict'

/**
 * The seam between this application and whatever extracts text from an image.
 *
 * This is the file to read first if you are adapting the skeleton. Everything
 * downstream — review queue, correction history, accuracy reporting, export —
 * depends only on the contract below, not on which model produced the numbers.
 * That is what lets you start on a mock, prototype against a hosted vision
 * API, and later move to a self-hosted model without touching a route, a
 * service or the UI.
 *
 * A provider is:
 *
 *   {
 *     name: string,
 *     async recognize({ filePath, docType, signal }): Promise<RecognitionResult>
 *   }
 *
 * RecognitionResult:
 *
 *   {
 *     docType?: string,              // classifier output, if the provider has one
 *     fields: [
 *       {
 *         key: string,               // stable field id: 'total_amount'
 *         rawValue: string,          // verbatim from the model, never cleaned
 *         confidence: number,        // 0..1
 *         bbox?: [x, y, w, h]        // pixels, for UI highlighting
 *       }
 *     ],
 *     meta?: object                  // model name, latency, token counts
 *   }
 *
 * Contract notes that matter in practice:
 *
 *  - `rawValue` is verbatim and `confidence` is honest. Normalisation belongs
 *    in a service, so that "the model read 1,2OO" stays visible in the
 *    correction history instead of being laundered into 1200 at the boundary.
 *  - A provider must not write to the database or touch storage. It takes a
 *    path, returns data. That is what makes it trivially testable.
 *  - Throw `UpstreamError` on a provider failure so one bad document degrades
 *    to "needs review" rather than failing the whole batch.
 */

const { UpstreamError } = require('../errors')

const providers = new Map()

/** @param {{ name: string, recognize: Function }} provider */
function registerProvider(provider) {
  if (!provider?.name || typeof provider.recognize !== 'function') {
    throw new Error('A provider needs a name and a recognize() function')
  }
  providers.set(provider.name, provider)
  return provider
}

function resolveProvider(name) {
  const provider = providers.get(name)
  if (!provider) {
    throw new Error(
      `Unknown recognition provider "${name}". Registered: ${[...providers.keys()].join(', ') || 'none'}. ` +
        'Register yours in lib/recognition/provider_registry.js.'
    )
  }
  return provider
}

function listProviders() {
  return [...providers.keys()]
}

/**
 * Wraps a provider so that every failure arrives as an `UpstreamError` with a
 * consistent code, and so no single document can hang a stage forever.
 */
function createRecognitionClient({ config }) {
  const provider = resolveProvider(config.recognition.provider)

  async function recognize({ filePath, docType = null }) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.recognition.timeoutMs)
    try {
      const result = await provider.recognize({ filePath, docType, signal: controller.signal })
      return normalizeResult(result, provider.name)
    } catch (error) {
      if (error instanceof UpstreamError) throw error
      throw new UpstreamError(`Recognition failed: ${error?.message || error}`, {
        code: 'recognition_failed',
        cause: error,
        details: { provider: provider.name },
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  return { providerName: provider.name, recognize }
}

/**
 * Defends the rest of the codebase against a provider that returns almost the
 * right shape. Clamping confidence matters more than it looks: a provider that
 * reports 0..100 instead of 0..1 would otherwise silently auto-approve
 * everything, because every value clears the review threshold.
 */
function normalizeResult(result, providerName) {
  const fields = Array.isArray(result?.fields) ? result.fields : []
  return {
    docType: result?.docType ?? null,
    fields: fields
      .filter((field) => field && typeof field.key === 'string')
      .map((field) => ({
        key: field.key,
        rawValue: field.rawValue == null ? '' : String(field.rawValue),
        confidence: clamp01(field.confidence),
        bbox: Array.isArray(field.bbox) && field.bbox.length === 4 ? field.bbox : null,
      })),
    meta: { provider: providerName, ...(result?.meta || {}) },
  }
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

// Built-ins. Requiring them here is what registers them.
registerProvider(require('./mock_provider'))
registerProvider(require('./http_provider'))

module.exports = {
  registerProvider,
  resolveProvider,
  listProviders,
  createRecognitionClient,
  normalizeResult,
}
