'use strict'

/**
 * 0002 — example JS migration.
 *
 * Kept in the skeleton as a worked example of the case `.sql` cannot handle:
 * adding a column *and* backfilling it from existing rows, conditionally.
 *
 * Two patterns to copy:
 *
 *  1. Check before you alter. SQLite has no `ADD COLUMN IF NOT EXISTS`, and a
 *     database that was hand-patched before the migration existed will
 *     otherwise fail the boot. Reading `pragma_table_info` makes the migration
 *     safe against that.
 *  2. No transaction here. The runner already wrapped this call in one — open
 *     another and you get "cannot start a transaction within a transaction".
 *
 * Do not add DDL to this file now that it has shipped: it will not re-run on
 * any database that already recorded version `0002`. Add `0003_…` instead.
 */

module.exports = function migrate(db) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('document')").all()
  const hasPageNumber = columns.some((column) => column.name === 'page_number')

  if (!hasPageNumber) {
    // Multi-page PDFs split into one `document` row per page; single images
    // stay at page 1, which is why the default is 1 rather than NULL.
    db.exec('ALTER TABLE document ADD COLUMN page_number INTEGER NOT NULL DEFAULT 1')
  }

  // Backfill anything a partial hand-patch left null. Harmless on a fresh
  // database (matches zero rows), which is what makes it safe to keep.
  db.prepare('UPDATE document SET page_number = 1 WHERE page_number IS NULL').run()

  db.exec('CREATE INDEX IF NOT EXISTS idx_document_page ON document (batch_id, page_number)')
}
