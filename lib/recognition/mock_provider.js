'use strict'

/**
 * Deterministic fake recognition. The default provider, and the reason a fresh
 * clone runs end to end with no model, no API key and no GPU.
 *
 * Deterministic on purpose: output is derived from a hash of the file path, so
 * the same document always produces the same fields and confidences. Random
 * output would make every test flaky and every demo unreproducible.
 *
 * The confidence spread is not decoration — it is what exercises the review
 * queue. Roughly one document in four lands below the default 0.85 threshold,
 * so `needs_review`, the correction UI and the field-history table all get hit
 * by the seed data instead of only in production.
 */

const crypto = require('node:crypto')
const path = require('node:path')

/**
 * Replace with your own fields. Keys must match what the export plan and the
 * SPA expect — `lib/export/export_plan_engine.js` and
 * `frontend/src/views/BatchDetailView.vue` both reference these.
 */
const FIELD_TEMPLATES = [
  { key: 'document_no', sample: (seed) => `DOC-${digitsFrom(seed, 8)}` },
  { key: 'issued_at', sample: (seed) => dateFrom(seed) },
  {
    key: 'counterparty',
    sample: (seed) => pick(seed, ['Acme Ltd', 'Globex', 'Initech', 'Umbrella']),
  },
  { key: 'total_amount', sample: (seed) => (500 + (seed % 9500)).toFixed(2) },
  { key: 'currency', sample: (seed) => pick(seed, ['USD', 'EUR', 'JPY', 'KRW']) },
]

function seedFrom(input) {
  return crypto.createHash('sha256').update(String(input)).digest().readUInt32BE(0)
}

function pick(seed, options) {
  return options[seed % options.length]
}

/**
 * Every generated value is a pure function of the seed — no `Math.random()`,
 * and no `Date.now()`. Either one would make this provider's output differ
 * between two calls on the same file, which is the one property tests and demos
 * depend on.
 */
function digitsFrom(seed, count) {
  return String(seed % 10 ** count).padStart(count, '0')
}

/** A plausible issue date within the last 90 days, fixed per seed. */
function dateFrom(seed) {
  // Anchored to an epoch constant rather than today, so the value does not
  // change when the clock rolls past midnight mid-test-run.
  const anchor = Date.UTC(2026, 0, 1)
  return new Date(anchor + (seed % 90) * 86_400_000).toISOString().slice(0, 10)
}

module.exports = {
  name: 'mock',

  async recognize({ filePath, docType = null }) {
    const seed = seedFrom(filePath)
    // 20 ms of latency so progress reporting and the SPA's polling loop behave
    // like they will against a real model, rather than finishing instantly.
    await new Promise((resolve) => setTimeout(resolve, 20))

    return {
      docType: docType || pick(seed, ['invoice', 'receipt', 'statement']),
      fields: FIELD_TEMPLATES.map((template, index) => {
        const fieldSeed = seed + index * 7919
        return {
          key: template.key,
          rawValue: template.sample(fieldSeed),
          // 0.60–0.99, stable per file+field. About a quarter fall under 0.85.
          confidence: 0.6 + (fieldSeed % 40) / 100,
          bbox: [40, 60 + index * 34, 260, 28],
        }
      }),
      meta: { provider: 'mock', file: path.basename(filePath) },
    }
  },
}
