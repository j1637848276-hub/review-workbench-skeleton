'use strict'

/**
 * Takes uploaded files from the temp directory into permanent storage and
 * registers a row per document.
 *
 * Intake is where a tool like this most often loses data, so the ordering is
 * deliberate: hash, move, then insert. A file on disk with no database row is
 * an orphan you can find and re-import. A database row pointing at a file that
 * was never written is a broken document an operator discovers a week later
 * when the export fails.
 *
 * Content hashing deduplicates re-uploads. Operators re-send folders — after a
 * network drop, or because they are not sure the first attempt worked — and
 * without a hash check the same document is reviewed and billed twice.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { BadRequestError } = require('../lib/errors')
const { logger } = require('../lib/request_logger')

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

function createDocumentIntakeService({ config, batchRepository, documentRepository }) {
  /**
   * @param {object} params
   * @param {string} params.batchId
   * @param {Array<{ path: string, originalname: string, size: number }>} params.files  multer output
   * @returns {Promise<{ accepted: object[], duplicates: object[], failed: object[] }>}
   */
  async function ingest({ batchId, files }) {
    batchRepository.assertWritable(batchId)

    if (!Array.isArray(files) || files.length === 0) {
      // Reached when every file was dropped by the upload filter, so say that
      // rather than "no files" — the operator did select some.
      throw new BadRequestError(
        'No usable files in this upload. Supported types: ' +
          config.uploads.allowedExtensions.join(', '),
        { code: 'no_files' }
      )
    }

    const targetDir = path.join(config.storage.documentsRoot, batchId)
    fs.mkdirSync(targetDir, { recursive: true })

    const accepted = []
    const duplicates = []
    const failed = []

    for (const file of files) {
      try {
        const contentHash = await hashFile(file.path)

        const existing = documentRepository.findByContentHash(contentHash)
        if (existing) {
          duplicates.push({
            originalName: file.originalname,
            existingDocumentId: existing.id,
            existingBatchId: existing.batch_id,
          })
          await fs.promises.unlink(file.path).catch(() => {})
          continue
        }

        const documentId = `${batchId}-${contentHash.slice(0, 12)}`
        const ext = path.extname(file.originalname).toLowerCase()
        const fileName = `${documentId}${ext}`
        const absolutePath = path.join(targetDir, fileName)

        // rename() fails across devices (a separate data volume is the normal
        // production layout), so fall back to copy + unlink.
        try {
          await fs.promises.rename(file.path, absolutePath)
        } catch (error) {
          if (error.code !== 'EXDEV') throw error
          await fs.promises.copyFile(file.path, absolutePath)
          await fs.promises.unlink(file.path).catch(() => {})
        }

        accepted.push({
          id: documentId,
          batchId,
          // Relative to STORAGE_ROOT so a restore onto a different path works.
          storagePath: path.relative(config.storage.root, absolutePath).split(path.sep).join('/'),
          originalName: file.originalname,
          contentHash,
          byteSize: file.size ?? null,
        })
      } catch (error) {
        // One unreadable file must not fail 299 good ones. Report it back so
        // the operator can retry that file alone.
        logger.error('intake_file_failed', { err: error, file: file.originalname, batchId })
        failed.push({ originalName: file.originalname, reason: error?.message || String(error) })
        await fs.promises.unlink(file.path).catch(() => {})
      }
    }

    if (accepted.length > 0) documentRepository.createMany(accepted)

    logger.info('intake_complete', {
      batchId,
      accepted: accepted.length,
      duplicates: duplicates.length,
      failed: failed.length,
    })

    return { accepted, duplicates, failed }
  }

  /**
   * Resolves a stored relative path to an absolute one, refusing anything that
   * escapes the storage root.
   *
   * This is the guard on the file-serving route. Path traversal via a stored
   * value sounds far-fetched until a migration or an import writes `../` into
   * a path column, and then `GET /api/documents/x/file` reads `/etc/passwd`.
   */
  function resolveStoragePath(storagePath) {
    const absolute = path.resolve(config.storage.root, storagePath)
    const root = path.resolve(config.storage.root)
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new BadRequestError('Invalid storage path', { code: 'invalid_path' })
    }
    return absolute
  }

  return { ingest, resolveStoragePath, hashFile }
}

module.exports = { createDocumentIntakeService }
