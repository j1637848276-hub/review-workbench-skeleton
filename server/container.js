'use strict'

/**
 * Wires everything together. The one place that knows the dependency graph.
 *
 * Hand-rolled constructor injection, no DI framework. Every module exports a
 * `createX({ deps })` factory and this file calls them in order. It is more
 * typing than a decorator-based container and worth it: the graph is readable
 * top to bottom, a cycle is a syntax-level impossibility, and a test can build
 * the exact slice it needs — `createDocumentRepository({ db })` against an
 * in-memory database, with no framework to bootstrap.
 *
 * Order matters and is the only constraint: storage, then repositories, then
 * services, then the things that need services.
 */

const fs = require('node:fs')

const { openDatabase, createDatabaseProbe } = require('../lib/storage/database')
const { createLockManager } = require('../lib/pipeline/advisory_lock')
const { createStageRunner } = require('../lib/pipeline/stage_runner')
const { createRecognitionClient } = require('../lib/recognition/provider_registry')
const { logger } = require('../lib/request_logger')

const { createAuditLogRepository } = require('../repositories/audit_log_repository')
const { createBatchRepository } = require('../repositories/batch_repository')
const { createDocumentRepository } = require('../repositories/document_repository')
const { createStageJobRepository } = require('../repositories/stage_job_repository')
const { createUserRepository } = require('../repositories/user_repository')

const { createAuthService } = require('../services/auth_service')
const { createDocumentIntakeService } = require('../services/document_intake_service')
const { createExportService } = require('../services/export_service')
const { createRecognitionStageService } = require('../services/recognition_stage_service')
const { createReviewService } = require('../services/review_service')

function createContainer({ config }) {
  // Directories first: a repository that opens a database in a directory that
  // does not exist fails with ENOENT, which reads like a permissions problem
  // and wastes an hour.
  for (const dir of [
    config.storage.root,
    config.storage.documentsRoot,
    config.storage.exportsRoot,
    config.storage.tmpUploadRoot,
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const db = openDatabase({ dbPath: config.storage.databasePath, logger })

  const repositories = {
    users: createUserRepository({ db }),
    auditLog: createAuditLogRepository({ db }),
    batches: createBatchRepository({ db }),
    documents: createDocumentRepository({ db }),
    stageJobs: createStageJobRepository({ db }),
  }

  const lockManager = createLockManager({ db })
  const stageRunner = createStageRunner({
    db,
    lockManager,
    stageJobRepository: repositories.stageJobs,
  })
  const recognitionClient = createRecognitionClient({ config })

  const services = {
    auth: createAuthService({ userRepository: repositories.users, config }),
    intake: createDocumentIntakeService({
      config,
      batchRepository: repositories.batches,
      documentRepository: repositories.documents,
    }),
    review: createReviewService({
      batchRepository: repositories.batches,
      documentRepository: repositories.documents,
    }),
    recognitionStage: createRecognitionStageService({
      config,
      batchRepository: repositories.batches,
      documentRepository: repositories.documents,
      recognitionClient,
      stageRunner,
    }),
    export: createExportService({
      config,
      batchRepository: repositories.batches,
      documentRepository: repositories.documents,
      stageRunner,
    }),
  }

  /** Registered on /readyz. Keep them cheap — a probe runs on every poll. */
  const healthProbes = {
    database: createDatabaseProbe(db),
    storage: () => {
      // Readable *and* writable: a full or read-only volume is the failure
      // that turns every upload into a 500, and `existsSync` would miss it.
      fs.accessSync(config.storage.root, fs.constants.R_OK | fs.constants.W_OK)
      return { ok: true, root: config.storage.root }
    },
    recognition: () => ({ ok: true, provider: recognitionClient.providerName }),
  }

  function close() {
    try {
      // Checkpoint so the WAL is folded back into the main file. Without it a
      // backup taken right after shutdown can miss the last commits.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch (error) {
      logger.warn('wal_checkpoint_failed', { err: error })
    }
    db.close()
  }

  return { config, db, repositories, services, lockManager, stageRunner, healthProbes, close }
}

module.exports = { createContainer }
