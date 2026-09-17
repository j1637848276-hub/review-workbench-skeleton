'use strict'

/**
 * Human review: correct fields, approve or reject a document, advance the
 * batch when the queue empties.
 *
 * Normalisation lives here rather than in the provider or the repository, so
 * that the model's verbatim output stays in `raw_value` and the cleaned value
 * lands in `value`. Keeping both is what makes "how often is the model wrong
 * about this field, and in what way" answerable later.
 */

const { BadRequestError, ConflictError } = require('../lib/errors')

/**
 * Per-field normalisation. Extend for your domain — this is one of the two or
 * three places most adaptations actually need to touch.
 *
 * Every function must be total: given junk, return the junk unchanged rather
 * than throwing. A malformed value should reach a human, not 500 the request
 * they were trying to fix it with.
 */
const NORMALIZERS = Object.freeze({
  total_amount: (value) => {
    // Thousands separators and stray currency symbols are what operators
    // actually type, and what the model actually reads off a printed receipt.
    const cleaned = String(value)
      .replace(/[^\d.,-]/g, '')
      .replace(/,/g, '')
    return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : String(value)
  },
  issued_at: (value) => {
    const text = String(value).trim()
    // Accept the three separators that show up in practice; reject anything
    // ambiguous rather than guessing between DD/MM and MM/DD.
    const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text)
    if (!match) return text
    const [, y, m, d] = match
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  },
  currency: (value) => String(value).trim().toUpperCase(),
})

function normalizeField(key, value) {
  if (value === null || value === undefined) return null
  const normalizer = NORMALIZERS[key]
  return normalizer ? normalizer(value) : String(value).trim()
}

function createReviewService({ batchRepository, documentRepository }) {
  function getDocumentDetail(documentId) {
    const document = documentRepository.requireById(documentId)
    return {
      document,
      fields: documentRepository.getFields(documentId),
      history: documentRepository.getHistory(documentId, 50),
      batch: batchRepository.findById(document.batchId),
    }
  }

  function listQueue({ batchId = null, limit = 50 } = {}) {
    return documentRepository.reviewQueue({ batchId, limit })
  }

  /**
   * @param {object} params
   * @param {Record<string, string>} params.corrections  field key -> new value
   */
  function applyCorrections({ documentId, corrections, userId, reason = null }) {
    const document = documentRepository.requireById(documentId)
    batchRepository.assertWritable(document.batchId)

    if (!corrections || typeof corrections !== 'object' || Array.isArray(corrections)) {
      throw new BadRequestError('corrections must be an object of field -> value', {
        code: 'invalid_corrections',
      })
    }
    const keys = Object.keys(corrections)
    if (keys.length === 0) {
      throw new BadRequestError('No fields to update', { code: 'empty_corrections' })
    }
    // Bound the payload: an unbounded object here is a cheap way to write a
    // million history rows in one request.
    if (keys.length > 100) {
      throw new BadRequestError('Too many fields in one request (max 100)', {
        code: 'too_many_fields',
      })
    }

    const normalized = Object.fromEntries(
      keys.map((key) => [key, normalizeField(key, corrections[key])])
    )

    const { changed } = documentRepository.applyCorrections({
      documentId,
      corrections: normalized,
      userId,
      reason,
    })

    return { documentId, changed, fields: documentRepository.getFields(documentId) }
  }

  /**
   * @param {'approved'|'rejected'} decision
   */
  function review({ documentId, decision, userId }) {
    if (!['approved', 'rejected'].includes(decision)) {
      throw new BadRequestError('decision must be "approved" or "rejected"', {
        code: 'invalid_decision',
      })
    }

    const document = documentRepository.requireById(documentId)
    batchRepository.assertWritable(document.batchId)

    if (document.status === 'approved' || document.status === 'rejected') {
      // Two reviewers opening the same queue item is normal; silently
      // overwriting the first decision is not.
      throw new ConflictError(`Document was already ${document.status}`, {
        code: 'already_reviewed',
        details: { reviewedBy: document.reviewedBy, reviewedAt: document.reviewedAt },
      })
    }

    const updated = documentRepository.setReviewStatus({ documentId, status: decision, userId })

    // Advance the batch once nothing is waiting on a human. Doing this here
    // rather than on a timer means the status the operator sees is the truth
    // at the moment they finish the last item.
    const remaining = documentRepository.reviewQueue({ batchId: document.batchId, limit: 1 })
    if (
      remaining.length === 0 &&
      batchRepository.findById(document.batchId)?.status === 'in_review'
    ) {
      batchRepository.setStatus(document.batchId, 'ready')
    }

    return updated
  }

  return { getDocumentDetail, listQueue, applyCorrections, review, normalizeField }
}

module.exports = { createReviewService, NORMALIZERS, normalizeField }
