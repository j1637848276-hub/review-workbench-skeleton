'use strict'

/**
 * Declarative spreadsheet exports.
 *
 * Every tool like this grows a long tail of "same data, different columns, for
 * a different recipient" exports. Written as code, each one is a hundred lines
 * of exceljs that only its author can safely change, and the fifth one is a
 * copy of the fourth. Written as a plan — a list of column specs — a new export
 * is a data literal, and the rendering is shared and tested once.
 *
 * A plan:
 *
 *   {
 *     id: 'batch_review',
 *     title: 'Batch review',
 *     sheetName: 'Documents',
 *     columns: [
 *       { header: 'Document no', key: 'document_no', width: 18 },
 *       { header: 'Amount', key: 'total_amount', width: 14, type: 'money' },
 *       { header: 'Issued', key: 'issued_at', width: 12, type: 'date' },
 *       { header: 'Confidence', key: 'min_confidence', width: 12, type: 'percent' },
 *       { header: 'Reviewer', key: 'reviewed_by_name', width: 16 },
 *     ],
 *     totals: ['total_amount'],
 *   }
 *
 * `type` drives both the number format and the alignment, so a money column is
 * right-aligned and two-decimal everywhere without each plan restating it.
 *
 * Money runs through decimal.js, never a float. `0.1 + 0.2` is the reason: an
 * export whose total is a cent off the source is worse than no export, because
 * someone has to spend an afternoon proving which number is wrong.
 */

const Decimal = require('decimal.js')

const COLUMN_TYPES = Object.freeze({
  text: { alignment: { horizontal: 'left' } },
  money: { numFmt: '#,##0.00', alignment: { horizontal: 'right' } },
  integer: { numFmt: '#,##0', alignment: { horizontal: 'right' } },
  percent: { numFmt: '0.0%', alignment: { horizontal: 'right' } },
  date: { numFmt: 'yyyy-mm-dd', alignment: { horizontal: 'center' } },
  datetime: { numFmt: 'yyyy-mm-dd hh:mm', alignment: { horizontal: 'center' } },
})

function assertValidPlan(plan) {
  if (!plan?.id) throw new Error('An export plan needs an id')
  if (!Array.isArray(plan.columns) || plan.columns.length === 0) {
    throw new Error(`Export plan "${plan.id}" has no columns`)
  }
  for (const column of plan.columns) {
    if (!column.key) throw new Error(`Export plan "${plan.id}" has a column without a key`)
    if (column.type && !COLUMN_TYPES[column.type]) {
      throw new Error(
        `Export plan "${plan.id}" column "${column.key}" has unknown type "${column.type}". ` +
          `Known types: ${Object.keys(COLUMN_TYPES).join(', ')}`
      )
    }
  }
}

/**
 * Turns a stored value into what the cell should hold.
 *
 * Money and percents must arrive as real numbers, not strings — a spreadsheet
 * where the recipient cannot sum a column is a spreadsheet they will retype by
 * hand. Dates stay strings because Excel serial dates are a bigger trap than
 * an ISO string that sorts correctly.
 */
function coerce(value, type) {
  if (value === null || value === undefined || value === '') return null
  switch (type) {
    case 'money':
      try {
        return new Decimal(String(value)).toDecimalPlaces(2).toNumber()
      } catch {
        // Keep the unparseable original visible rather than blanking it: a
        // cell reading "1,2OO" tells the operator exactly what to fix.
        return String(value)
      }
    case 'integer': {
      const parsed = Number.parseInt(String(value), 10)
      return Number.isFinite(parsed) ? parsed : String(value)
    }
    case 'percent': {
      const parsed = Number.parseFloat(String(value))
      return Number.isFinite(parsed) ? parsed : null
    }
    default:
      return typeof value === 'object' ? JSON.stringify(value) : value
  }
}

function sumColumn(rows, key) {
  return rows
    .reduce((total, row) => {
      try {
        return total.plus(new Decimal(String(row[key] ?? 0)))
      } catch {
        // A non-numeric cell must not poison the total. It is already visible
        // in its own row; silently dropping it from the sum is the lesser evil
        // against an export that throws.
        return total
      }
    }, new Decimal(0))
    .toDecimalPlaces(2)
    .toNumber()
}

/**
 * @param {object} plan
 * @param {Array<object>} rows  flat objects keyed by the plan's column keys
 * @param {object} [meta]       rendered into a header block above the table
 */
function buildWorkbookSpec(plan, rows, meta = {}) {
  assertValidPlan(plan)

  const columns = plan.columns.map((column) => ({
    header: column.header ?? column.key,
    key: column.key,
    width: column.width ?? 16,
    type: column.type ?? 'text',
    style: COLUMN_TYPES[column.type ?? 'text'],
  }))

  const dataRows = rows.map((row) => {
    const output = {}
    for (const column of columns) output[column.key] = coerce(row[column.key], column.type)
    return output
  })

  const totals =
    Array.isArray(plan.totals) && plan.totals.length > 0
      ? Object.fromEntries(plan.totals.map((key) => [key, sumColumn(rows, key)]))
      : null

  return {
    id: plan.id,
    title: plan.title ?? plan.id,
    sheetName: plan.sheetName ?? 'Sheet1',
    // Stamped into the file so a spreadsheet found on a shared drive in six
    // months can still be traced to the batch and the moment it was produced.
    meta: { generatedAt: new Date().toISOString(), rowCount: dataRows.length, ...meta },
    columns,
    rows: dataRows,
    totals,
  }
}

module.exports = { buildWorkbookSpec, assertValidPlan, COLUMN_TYPES }
