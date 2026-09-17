'use strict'

/**
 * Renders a workbook spec to .xlsx. The only file that knows exceljs exists —
 * swapping in a CSV or PDF renderer means adding a sibling here, not touching
 * the engine or any service.
 *
 * Streams to disk rather than buffering. A 50k-row export buffered in memory is
 * a few hundred MB of heap at exactly the moment several operators trigger
 * exports at once; streaming keeps it flat.
 */

const fs = require('node:fs')
const path = require('node:path')

const ExcelJS = require('exceljs')

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2933' } }
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
const BORDER = { style: 'thin', color: { argb: 'FFD8DEE4' } }

/**
 * @param {object} spec  from lib/export/export_plan_engine.js
 * @param {string} outputPath
 * @returns {Promise<{ path: string, bytes: number, rows: number }>}
 */
async function writeXlsx(spec, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outputPath,
    useStyles: true,
    useSharedStrings: true,
  })
  workbook.created = new Date()

  const sheet = workbook.addWorksheet(spec.sheetName, {
    // Header rows stay visible while scrolling. Sounds cosmetic; it is the
    // difference between an operator trusting a 2000-row sheet and not.
    views: [{ state: 'frozen', ySplit: 2 }],
  })

  sheet.columns = spec.columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
    style: column.style,
  }))

  // Row 1: provenance. Row 2: the real header row.
  const metaRow = sheet.addRow([
    `${spec.title} — generated ${spec.meta.generatedAt}${spec.meta.batchId ? ` — batch ${spec.meta.batchId}` : ''}`,
  ])
  metaRow.font = { italic: true, color: { argb: 'FF6B7785' }, size: 9 }
  metaRow.commit()

  const headerRow = sheet.addRow(spec.columns.map((column) => column.header))
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER }
  })
  headerRow.height = 22
  headerRow.commit()

  for (const row of spec.rows) {
    const added = sheet.addRow(spec.columns.map((column) => row[column.key]))
    added.eachCell((cell, columnNumber) => {
      const column = spec.columns[columnNumber - 1]
      if (column?.style?.numFmt) cell.numFmt = column.style.numFmt
      if (column?.style?.alignment) cell.alignment = column.style.alignment
      cell.border = { bottom: BORDER }
    })
    // Commit per row — this is what keeps memory flat on a large export.
    added.commit()
  }

  if (spec.totals) {
    const totalsRow = sheet.addRow(
      spec.columns.map((column, index) =>
        index === 0 ? 'Total' : (spec.totals[column.key] ?? null)
      )
    )
    totalsRow.font = { bold: true }
    totalsRow.eachCell((cell, columnNumber) => {
      const column = spec.columns[columnNumber - 1]
      if (column?.style?.numFmt) cell.numFmt = column.style.numFmt
      cell.border = { top: { style: 'double', color: { argb: 'FF1F2933' } } }
    })
    totalsRow.commit()
  }

  sheet.commit()
  await workbook.commit()

  const { size } = await fs.promises.stat(outputPath)
  return { path: outputPath, bytes: size, rows: spec.rows.length }
}

module.exports = { writeXlsx }
