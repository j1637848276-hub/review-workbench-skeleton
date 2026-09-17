-- 0001_init — core schema.
--
-- Shape this to your domain. The names here are deliberately generic:
--   batch     one upload session / one business day / one shipment
--   document  one file inside a batch (an image, a scan, a PDF page)
--   field     one extracted value on a document, with its confidence
--   stage_job one run of a pipeline stage over a batch
--
-- Conventions used throughout, worth keeping:
--   * timestamps are TEXT in ISO-8601 UTC. SQLite has no date type, and ISO
--     strings sort correctly, compare correctly, and survive a CSV round trip.
--   * money is TEXT, never REAL. Float arithmetic on money produces cents that
--     do not add up, and a reconciliation tool that is off by a cent is worse
--     than no tool. Parse with decimal.js at the edges.
--   * status columns are constrained by CHECK. An invalid state should fail at
--     the write, not be discovered by a report three weeks later.

-- ---------------------------------------------------------------- users
CREATE TABLE user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'reviewer', 'viewer')),
  display_name  TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  last_login_at TEXT
);

-- ---------------------------------------------------------------- audit log
-- Append-only. Never UPDATE or DELETE a row here: the value of an audit log is
-- entirely that it cannot be edited after the fact. Prune by archiving whole
-- date ranges to cold storage, not by deleting individual rows.
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at   TEXT    NOT NULL,
  user_id       INTEGER REFERENCES user(id),
  username      TEXT,             -- denormalised: the log must still read correctly
                                  -- after the account is renamed or removed
  action        TEXT    NOT NULL, -- 'login', 'import_batch', 'export_batch', ...
  resource_type TEXT,             -- 'batch', 'document', 'user', ...
  resource_id   TEXT,
  status_code   INTEGER,
  request_id    TEXT,             -- joins this row to its log lines
  ip            TEXT,
  details       TEXT              -- JSON blob; keep it small and PII-free
);

CREATE INDEX idx_audit_log_occurred    ON audit_log (occurred_at DESC);
CREATE INDEX idx_audit_log_user        ON audit_log (user_id, occurred_at DESC);
CREATE INDEX idx_audit_log_resource    ON audit_log (resource_type, resource_id);

-- ---------------------------------------------------------------- batches
CREATE TABLE batch (
  id           TEXT    PRIMARY KEY,           -- caller-supplied, e.g. '2026-09-17-a'
  label        TEXT    NOT NULL,
  business_day TEXT    NOT NULL,              -- 'YYYY-MM-DD' in the service timezone
  status       TEXT    NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'recognizing', 'in_review', 'ready', 'exported', 'archived')),
  -- Set once a period is closed. Every write path must check this: the point
  -- of a lock is that yesterday's numbers stay the numbers you reported.
  locked_at    TEXT,
  locked_by    INTEGER REFERENCES user(id),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  created_by   INTEGER REFERENCES user(id),
  notes        TEXT
);

CREATE INDEX idx_batch_business_day ON batch (business_day DESC);
CREATE INDEX idx_batch_status       ON batch (status, updated_at DESC);

-- ---------------------------------------------------------------- documents
CREATE TABLE document (
  id             TEXT    PRIMARY KEY,
  batch_id       TEXT    NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  -- Path relative to STORAGE_ROOT, never absolute: an absolute path breaks the
  -- moment the volume is remounted or the data is restored elsewhere.
  storage_path   TEXT    NOT NULL,
  original_name  TEXT    NOT NULL,
  content_hash   TEXT,                        -- sha256; how re-uploads are detected
  byte_size      INTEGER,
  doc_type       TEXT,                        -- your classifier's output
  status         TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'recognized', 'needs_review', 'approved', 'rejected')),
  -- Lowest field confidence on the document; what the review queue sorts by.
  min_confidence REAL,
  reviewed_by    INTEGER REFERENCES user(id),
  reviewed_at    TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX idx_document_batch       ON document (batch_id, status);
CREATE INDEX idx_document_status      ON document (status, min_confidence);
-- Partial index: the duplicate check only ever asks about documents that have
-- a hash, so the null rows are dead weight in a full index.
CREATE INDEX idx_document_hash        ON document (content_hash) WHERE content_hash IS NOT NULL;

-- ---------------------------------------------------------------- fields
-- One row per extracted value. Kept separate from `document` rather than as a
-- JSON column so that "show me every field a human had to correct" and "what
-- is our accuracy on field X" are one query each instead of a scan.
CREATE TABLE document_field (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   TEXT    NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  field_key     TEXT    NOT NULL,       -- 'total_amount', 'issued_at', ...
  raw_value     TEXT,                   -- exactly what the model returned
  value         TEXT,                   -- normalised, and corrected by a human
  confidence    REAL,
  source        TEXT    NOT NULL DEFAULT 'model'
                  CHECK (source IN ('model', 'human', 'rule', 'import')),
  corrected     INTEGER NOT NULL DEFAULT 0 CHECK (corrected IN (0, 1)),
  bbox          TEXT,                   -- JSON [x, y, w, h]; lets the UI highlight
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  UNIQUE (document_id, field_key)
);

CREATE INDEX idx_field_key_corrected ON document_field (field_key, corrected);

-- ---------------------------------------------------------------- field history
-- Who changed what, from what, to what. An operator will eventually ask "this
-- said 1,200 yesterday" and without this table the honest answer is a shrug.
CREATE TABLE field_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT    NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  field_key   TEXT    NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  INTEGER REFERENCES user(id),
  changed_at  TEXT    NOT NULL,
  reason      TEXT
);

CREATE INDEX idx_field_history_doc ON field_history (document_id, changed_at DESC);

-- ---------------------------------------------------------------- stage jobs
CREATE TABLE stage_job (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       TEXT    NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  stage          TEXT    NOT NULL,   -- 'recognize', 'validate', 'export', ...
  status         TEXT    NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- Caller-supplied idempotency key. A double-clicked button must not start
  -- two exports; the unique index below is what actually prevents it.
  idempotency_key TEXT,
  progress       INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT,
  finished_at    TEXT,
  error_message  TEXT,
  triggered_by   INTEGER REFERENCES user(id),
  created_at     TEXT    NOT NULL
);

CREATE UNIQUE INDEX idx_stage_job_idempotency
  ON stage_job (batch_id, stage, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_stage_job_batch  ON stage_job (batch_id, created_at DESC);
CREATE INDEX idx_stage_job_status ON stage_job (status, created_at);

-- ---------------------------------------------------------------- advisory locks
-- Cooperative mutual exclusion for work that must not overlap: two concurrent
-- recognition runs over one batch will interleave writes and produce a result
-- neither run would have produced alone. Rows are deleted at boot (see
-- lib/storage/database.js) because a lock cannot outlive the process holding it.
CREATE TABLE advisory_lock (
  lock_key    TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL,
  holder      TEXT NOT NULL,        -- pid + stage, for a useful error message
  expires_at  TEXT NOT NULL
);
