'use strict'

/**
 * Turns a batch into a spreadsheet, using a named export plan.
 *
 * Plans live in `EXPORT_PLANS` below. Adding a recipient-specific export means
 * adding a data literal here, not writing another renderer — which is the
 * whole reason the export engine is declarative. See
 * `lib/export/export_plan_engine.js` for the column spec.
 *
 * Exports run as a stage rather than inline: a 20k-row workbook takes long
 * enough that an HTTP request would time out behind most proxies, and an
 * operator who clicks twice must not get two files.
 */

const fs = require('node:fs')
const path = require('node:path')

const { BadRequestError, NotFoundError } = require('../lib/errors')
const { buildWorkbookSpec } = require('../lib/export/export_plan_engine')
const { writeXlsx } = require('../lib/export/xlsx_writer')

/**
 * TODO — replace with your recipients' formats.
 *
 * `key` refers to a flattened row: document columns plus one entry per field
 * key (see `flattenDocument` below).
 */
const EXPORT_PLANS = Object.freeze({
  batch_review: {
    id: 'batch_review',
    title: 'Batch review',
    sheetName: 'Documents',
    columns: [
      { header: 'Document', key: 'document_no', width: 20 },
      { header: 'Type', key: 'doc_type', width: 14 },
      { header: 'Issued', key: 'issued_at', width: 12, type: 'date' },
      { header: 'Counterparty', key: 'counterparty', width: 24 },
      { header: 'Amount', key: 'total_amount', width: 14, type: 'money' },
      { header: 'Currency', key: 'currency', width: 10 },
      { header: 'Confidence', key: 'min_confidence', width: 12, type: 'percent' },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Source file', key: 'original_name', width: 30 },
    ],
    totals: ['total_amount'],
  },

  // A second plan over the same data, to show what varying by recipient looks
  // like: fewer columns, no internal confidence, no source filenames.
  counterparty_summary: {
    id: 'counterparty_summary',
    title: 'Counterparty summary',
    sheetName: 'Summary',
    columns: [
      { header: 'Document', key: 'document_no', width: 20 },
      { header: 'Issued', key: 'issued_at', width: 12, type: 'date' },
      { header: 'Amount', key: 'total_amount', width: 14, type: 'money' },
      { header: 'Currency', key: 'currency', width: 10 },
    ],
    totals: ['total_amount'],
  },
})

function createExportService({ config, batchRepository, documentRepository, stageRunner }) {
  function listPlans() {
    return Object.values(EXPORT_PLANS).map((plan) => ({
      id: plan.id,
      title: plan.title,
      columns: plan.columns.length,
    }))
  }

  function start({ batchId, planId, userId = null, idempotencyKey = null }) {
    const plan = EXPORT_PLANS[planId]
    if (!plan) {
      throw new BadRequestError(
        `Unknown export plan "${planId}". Available: ${Object.keys(EXPORT_PLANS).join(', ')}`,
        { code: 'unknown_export_plan' }
      )
    }
    // Reading a locked batch is fine — exporting a closed period is the normal
    // case — so this is requireById, not assertWritable.
    batchRepository.requireById(batchId)

    return stageRunner.start({
      batchId,
      stage: `export:${planId}`,
      idempotencyKey,
      userId,
      work: ({ reportProgress }) => runExport({ batchId, plan, reportProgress }),
    })
  }

  async function runExport({ batchId, plan, reportProgress }) {
    const batch = batchRepository.requireById(batchId)

    // Paged rather than one big SELECT: a batch is bounded in practice, but
    // "in practice" is where memory blowups live.
    const pageSize = 500
    const rows = []
    let offset = 0
    let total = Infinity

    while (offset < total) {
      const page = documentRepository.listByBatch(batchId, { limit: pageSize, offset })
      total = page.total
      for (const document of page.documents) {
        rows.push(flattenDocument(document, documentRepository.getFields(document.id)))
      }
      offset += pageSize
      reportProgress(Math.min(offset, total), total)
      if (page.documents.length === 0) break // defensive: never spin forever
    }

    const spec = buildWorkbookSpec(plan, rows, {
      batchId,
      batchLabel: batch.label,
      businessDay: batch.businessDay,
    })

    const fileName = `${batchId}_${plan.id}_${Date.now()}.xlsx`
    const outputPath = path.join(config.storage.exportsRoot, batchId, fileName)
    const written = await writeXlsx(spec, outputPath)

    batchRepository.setStatus(batchId, 'exported')

    return {
      ...written,
      // Relative so the download route can resolve it under STORAGE_ROOT
      // regardless of where the volume is mounted.
      relativePath: path.relative(config.storage.root, outputPath).split(path.sep).join('/'),
      fileName,
    }
  }

  /**
   * Document columns plus one column per extracted field. Field values win on
   * a key collision, which is why `min_confidence` and `status` are named
   * differently from anything a provider would emit.
   */
  function flattenDocument(document, fields) {
    const flat = {
      document_id: document.id,
      original_name: document.originalName,
      doc_type: document.docType,
      status: document.status,
      min_confidence: document.minConfidence,
      page_number: document.pageNumber,
    }
    for (const field of fields) flat[field.key] = field.value ?? field.rawValue
    return flat
  }

  /** Resolves a produced file for download, refusing paths outside storage. */
  function resolveExportFile(relativePath) {
    const absolute = path.resolve(config.storage.root, relativePath)
    const root = path.resolve(config.storage.exportsRoot)
    if (!absolute.startsWith(root + path.sep)) {
      throw new BadRequestError('Invalid export path', { code: 'invalid_path' })
    }
    if (!fs.existsSync(absolute)) {
      throw new NotFoundError('Export file no longer exists', { code: 'export_missing' })
    }
    return absolute
  }

  return { listPlans, start, resolveExportFile, flattenDocument }
}

module.exports = { createExportService, EXPORT_PLANS }
