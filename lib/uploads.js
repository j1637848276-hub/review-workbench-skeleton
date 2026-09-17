'use strict'

/**
 * Multer configuration and the upload allow-list.
 *
 * Two decisions here are not obvious and both come from watching real
 * operators use a tool like this.
 *
 * 1. Unknown file types are *dropped*, not rejected. Operators select whole
 *    folders, and a folder contains `Thumbs.db`, `.DS_Store` and a stray
 *    `notes.txt`. Failing the request means 300 good images are rejected
 *    because of one junk file, and the operator's fix is to clean the folder
 *    by hand. Dropping silently keeps the batch moving; the response reports
 *    how many files were accepted so nothing vanishes without a trace.
 *
 * 2. Office lock files are rejected loudly. A file starting with `~$` means
 *    the spreadsheet is open in Excel, so the upload would be a zero-byte
 *    stub. "Close the file first" is actionable; a mystery empty import is not.
 *
 * Extension checks are an ergonomic filter, not a security boundary. Anything
 * can be renamed to `.jpg`. The actual boundary is downstream: these files are
 * served from a path that never executes, and every one is decoded before use.
 */

const fs = require('node:fs')
const path = require('node:path')

const multer = require('multer')

const SAFE_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
])

function isOfficeLockFile(file) {
  return path.basename(String(file?.originalname || '')).startsWith('~$')
}

function createUploadFileFilter({ allowedExtensions = [] } = {}) {
  const allowed = new Set(allowedExtensions.map((ext) => String(ext).toLowerCase()))

  return function fileFilter(_req, file, cb) {
    if (isOfficeLockFile(file)) {
      const error = new Error('Close the file in Excel first — "~$" files are empty lock stubs.')
      error.code = 'OFFICE_LOCK_FILE'
      return cb(error)
    }

    const ext = path.extname(String(file.originalname || '')).toLowerCase()
    if (allowed.has(ext)) return cb(null, true)

    // Phones and some scanners hand over hash-named files with no extension.
    // Trust the browser-reported MIME for those, and only for known-safe types.
    if (!ext && SAFE_IMAGE_MIME.has(String(file.mimetype || '').toLowerCase())) {
      return cb(null, true)
    }

    return cb(null, false) // dropped, see note 1
  }
}

function createUploadMiddleware({ config }) {
  fs.mkdirSync(config.storage.tmpUploadRoot, { recursive: true })

  // Disk storage, not memory: 500 files at 25 MB is 12 GB, and memory storage
  // would put all of it on the heap at once.
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, config.storage.tmpUploadRoot),
      filename: (_req, file, cb) => {
        // Never trust the client's filename on disk. Path separators, `..` and
        // reserved Windows device names all arrive eventually; the original is
        // preserved in the database instead.
        const ext = path.extname(file.originalname).toLowerCase().slice(0, 10)
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`)
      },
    }),
    fileFilter: createUploadFileFilter({ allowedExtensions: config.uploads.allowedExtensions }),
    limits: {
      files: config.uploads.maxFilesPerRequest,
      fileSize: config.uploads.maxFileSizeMb * 1024 * 1024,
      // Cap field count too: without it, a crafted multipart body with a
      // million tiny fields is a cheap way to exhaust memory.
      fields: 50,
    },
  })
}

/** Used by tests and by routes that must run without an upload path wired. */
function createNoopUpload() {
  const passthrough = () => (_req, _res, next) => next()
  return { array: passthrough, single: passthrough, none: passthrough }
}

module.exports = {
  createUploadMiddleware,
  createUploadFileFilter,
  createNoopUpload,
  isOfficeLockFile,
}
