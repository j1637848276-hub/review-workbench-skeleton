'use strict'

/**
 * Posts the image to an HTTP model service and maps the reply to the provider
 * contract. Works against a self-hosted OCR service, a hosted vision API, or a
 * small FastAPI wrapper around your own weights.
 *
 * Two things here are the actual work of adapting this file, and both are
 * marked TODO: the request shape your service expects, and the mapping from
 * its response back to `{ key, rawValue, confidence, bbox }`. Everything else
 * — timeout, abort, error classification — is already correct and generic.
 *
 * The mapping function is where accuracy work happens later. Keep it a pure
 * function of the response so you can test it against captured fixtures rather
 * than against a live model.
 */

const fs = require('node:fs')
const path = require('node:path')

const { UpstreamError } = require('../errors')

function resolveSettings() {
  return {
    endpoint: process.env.RECOGNITION_ENDPOINT || '',
    apiKey: process.env.RECOGNITION_API_KEY || '',
  }
}

/**
 * TODO — replace with your service's response shape.
 *
 * Written defensively because a model service is the one dependency that
 * changes its output without telling you: an unexpected shape must degrade to
 * "no fields, send it to review", never throw and fail the batch.
 */
function mapResponseToFields(payload) {
  const items = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.fields)
      ? payload.fields
      : []

  return items
    .map((item) => ({
      key: String(item?.name ?? item?.key ?? '').trim(),
      rawValue: item?.text ?? item?.value ?? '',
      // Some services report a distance or a percentage. Normalise to 0..1
      // here — the registry clamps, but a silently clamped 97 becomes 1.0 and
      // auto-approves a field nobody checked.
      confidence: Number(item?.confidence ?? item?.score ?? 0),
      bbox: item?.bbox ?? item?.box ?? null,
    }))
    .filter((field) => field.key !== '')
}

module.exports = {
  name: 'http',

  async recognize({ filePath, docType = null, signal }) {
    const { endpoint, apiKey } = resolveSettings()
    if (!endpoint) {
      throw new UpstreamError('RECOGNITION_ENDPOINT is not set.', {
        code: 'recognition_misconfigured',
      })
    }

    // Streaming the file would be better for very large inputs; documents here
    // are capped by UPLOAD_MAX_FILE_SIZE_MB, so a buffer keeps this readable.
    const buffer = await fs.promises.readFile(filePath)
    const form = new FormData()
    form.append('file', new Blob([buffer]), path.basename(filePath))
    if (docType) form.append('doc_type', docType)

    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal,
      })
    } catch (error) {
      // AbortError means our own timeout fired. Say so, because "model service
      // is down" and "model service is slow" need different responses.
      const aborted = error?.name === 'AbortError'
      throw new UpstreamError(
        aborted ? 'Recognition timed out.' : `Cannot reach recognition service: ${error?.message}`,
        { code: aborted ? 'recognition_timeout' : 'recognition_unreachable', cause: error }
      )
    }

    if (!response.ok) {
      // Truncated: a model service error body can be a megabyte of HTML, and
      // it ends up in a log line and an operator's error toast.
      const body = await response.text().catch(() => '')
      throw new UpstreamError(`Recognition service returned ${response.status}`, {
        code: 'recognition_http_error',
        details: { status: response.status, body: body.slice(0, 500) },
      })
    }

    const payload = await response.json().catch(() => ({}))
    return {
      docType: payload?.doc_type ?? docType ?? null,
      fields: mapResponseToFields(payload),
      meta: { model: payload?.model ?? null, latencyMs: payload?.latency_ms ?? null },
    }
  },
}
