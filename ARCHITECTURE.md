# Architecture

Why the code is shaped this way. Read this before changing the structure —
several things that look like accidents are load-bearing, and a few things that
look settled are the first ones you should outgrow.

## The one-paragraph version

An Express process serves a JSON API and a built Vue SPA from the same origin.
Requests flow `routes → services → repositories → SQLite`. Long work — model
inference over hundreds of documents, building a large spreadsheet — runs in the
background behind a job row the SPA polls. Everything that can fail on
misconfiguration fails at boot, before the port opens.

## Layering

```
routes/         HTTP only: parse, delegate, shape a response. No business rules.
services/       Business rules. No SQL, no req/res.
repositories/   All SQL. One row-mapping boundary.
lib/            Cross-cutting: config, errors, logging, auth, storage, pipeline.
```

The rule that makes this worth enforcing: **a service must be callable without an
HTTP request, and a repository must be the only thing that knows SQL exists.**
Both are testable in isolation, and both stay testable as the app grows. The
moment a service takes `req`, that stops being true.

Two boundaries do specific work:

- **Row mapping.** The database speaks `snake_case` and `0|1`; the application
  speaks `camelCase` and booleans. Converting in exactly one place per table
  prevents the failure where both `is_active` and `isActive` are in use and a
  permission check silently never fires.
- **Error translation.** Repositories turn driver errors into the app's error
  types — a `UNIQUE` violation becomes `ConflictError`, which becomes a 409. A
  raw driver message reaching a client is both a 500 and an information leak.

## Configuration

`lib/config.js` reads `process.env` once, at boot, validates it, and freezes the
result. Nothing else in the codebase touches `process.env`.

Two payoffs. A missing `JWT_SECRET` kills the process during deployment, where a
health check catches it — rather than throwing on the first login hours later.
And "what is production actually running?" is answerable from one file plus
`GET /healthz`, not from a grep across two hundred modules.

Validation refuses to start on: no `JWT_SECRET` with auth on, a secret under 32
characters, `RECOGNITION_PROVIDER=http` with no endpoint, a review threshold
outside 0–1, and `AUTH_ENABLED=false` under `NODE_ENV=production`.

## Middleware order

In `server/create_app.js`. Every position is deliberate:

1. **request logger** — first, so every later log line and every response
   carries a request id
2. **security headers** — before anything can produce a response
3. **health routes** — unauthenticated and before body parsing, so probes work
   while the rest of the app is broken or still warming up
4. **body + cookie parsers**
5. **audit middleware** — after auth populates `req.user`, before the routes it
   records
6. **routes**
7. **SPA static + history fallback** — last, so it cannot shadow an `/api` route
8. **error handler** — after every route, or it sees nothing

Moving 3 below 4 means a malformed body can break a health check. Moving 7 above
6 means a file named `api` in the build shadows the API. Moving 8 anywhere but
last means some routes' errors fall through to Express's default handler, which
returns HTML and logs nothing.

## Errors

One error type per HTTP outcome (`lib/errors.js`). Services throw them;
`lib/api_error_middleware.js` is the single exit.

An error either has a deliberate contract or it is a bug. `AppError` and its
subclasses get their declared status and a machine `code`, logged at `warn` — a
404 is not an incident, and logging it as one trains people to ignore the error
stream. Everything else is logged whole at `error` and returned as a bare 500.

The envelope is stable, because the SPA's interceptor and every support
conversation depend on it:

```json
{ "error": "human readable", "code": "machine_readable", "requestId": "a1b2c3d4e5f6a7b8" }
```

`requestId` is what makes an operator's screenshot actionable: it maps to
exactly one log line.

## Logging

`lib/request_logger.js`: JSON lines, no dependency. `warn` and `error` go to
stderr so `2>` splits the stream that pages someone.

The interesting part is `AsyncLocalStorage`. A service five calls deep never
receives the request object, but `logger.info()` there still emits the right
`reqId`. Without that, correlating a failure across layers means threading a
context argument through every signature.

A redaction list drops `password`, `token`, `authorization`, `cookie`, `apiKey`
and friends at any nesting depth. Extend it when you add a sensitive field —
this is the kind of leak nobody notices until logs are shared.

## Storage

**SQLite via `node:sqlite`.** One file, no server to operate, atomic backups by
copy, and comfortable with the read-heavy load of a few dozen operators. No
native build step, unlike `better-sqlite3`.

Pragmas set in `lib/storage/database.js`:

| Pragma         | Value    | Why                                                                                                                             |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `journal_mode` | `WAL`    | Readers never block the writer — a browsing operator and a running export coexist                                               |
| `synchronous`  | `NORMAL` | Survives a process crash; may lose the last commits in a hard power loss. Use `FULL` if a lost transaction means a lost payment |
| `foreign_keys` | `ON`     | Not the default. Off, `ON DELETE CASCADE` silently does nothing                                                                 |
| `busy_timeout` | `5000`   | Wait for a lock instead of surfacing `SQLITE_BUSY` to the operator                                                              |

**Migrations** are forward-only, applied at boot, one transaction each, with the
version row inserted in the same transaction. A migration cannot half-apply and
the ledger cannot disagree with the schema. A failure aborts the boot: serving
traffic against a half-migrated schema corrupts data in ways that are expensive
to unpick, while refusing to start is an outage you fix in minutes.

No `down` migrations. Nobody tests them, and an unexercised rollback is worse
than none. Roll forward: restore a backup, or add `0043_undo_0042`.

**Never edit an applied migration.** It will not re-run, so your database and
everyone else's silently diverge.

**Transactions** go through `runInTransaction`, which uses a SAVEPOINT when one
is already open. Without that, a service wrapping its writes in a transaction
breaks the moment another transaction-opening service calls it — the inner
`COMMIT` publishes the outer's half-finished work. That bug is subtle,
load-dependent, and expensive to find.

### Conventions in the schema

- Timestamps are `TEXT`, ISO-8601 UTC. SQLite has no date type; ISO strings sort
  and compare correctly and survive a CSV round trip.
- Money is `TEXT`, never `REAL`. Float arithmetic produces cents that do not add
  up, and a reconciliation tool that is off by a cent is worse than no tool.
  Parse with `decimal.js` at the edges.
- Status columns carry `CHECK` constraints. An invalid state should fail at the
  write, not be discovered by a report three weeks later.

## Auth

JWT in an httpOnly cookie, not `Authorization: Bearer`. For a first-party SPA
that is safer: an httpOnly cookie is unreadable from JavaScript, so an XSS bug
cannot exfiltrate the session the way a token in `localStorage` can. The cost is
CSRF exposure, which `sameSite: 'lax'` covers for a single origin. Add a second
origin and you need a CSRF token — do not reach for `sameSite: 'none'`.

`lax` rather than `strict` because strict drops the cookie on `<img src>` and on
cross-site navigation _into_ the app, which presents as random 401s on image
loads.

**The user is re-read from storage on every request.** Without it, a 24-hour
token keeps working after an account is disabled or demoted, and you cannot
revoke anything until it expires. One primary-key lookup per request is a cheap
price for "deactivating an account takes effect now".

**401 and 403 mean different things and the SPA depends on it.** 401 is "not
authenticated" and triggers a redirect to login; 403 is "authenticated,
insufficient role" and must not, or a legitimately signed-in user gets bounced
out of the app.

Passwords use scrypt with parameters stored alongside the hash, so raising the
work factor later does not invalidate existing hashes — they upgrade on next
login.

## Audit

A route table in `lib/audit_middleware.js`, not an `audit()` call in each
handler. The calls get forgotten: a new export endpoint ships and a year later
nobody can answer "who exported this". A table is reviewable in one screen, and
`tests/audit_and_export.test.js` walks the registered routes and fails when a
mutating one is neither listed nor explicitly exempt.

Writes happen on `res.on('finish')`, so audit logging never adds latency and a
logging failure cannot fail the operation. The trade is explicit: **this is an
audit trail, not a two-phase commit.** If you need "the write did not happen
unless it was logged", move the insert into the write's own transaction.

Only successful requests are recorded — a 400 changed nothing. Failed _logins_
are the exception, because those are what an incident review needs.

The log is append-only. `audit_log_repository.js` has no update or delete
method, and its absence is the cheapest enforcement available.

## Background work

`lib/pipeline/stage_runner.js`. A stage is minutes of work over hundreds of
documents, kicked off by a request that must not wait for it. The route returns
a job id; the SPA polls `GET /api/batches/:id/jobs/:jobId`.

Every stage gets, for free: an advisory lock so two runs cannot overlap, an
idempotency key so a double-clicked button starts one job, progress counters,
and a terminal status with an error message — including on crash.

**Advisory locks** are an `INSERT` against a primary key: the cheapest reliable
way to make the second attempt lose. They carry a TTL because a `SIGKILL`ed
process leaves its lock row behind and wedges the batch. Boot recovery clears
them, but a long-lived process that hangs internally never reboots — the TTL
covers that. Set it above your worst-case stage duration or a slow run gets its
lock stolen mid-work.

**Bounded concurrency, not `Promise.all`.** 500 documents through `Promise.all`
opens 500 simultaneous requests to your model service, which either rate-limits
you or falls over. A fixed pool of N workers pulling from one cursor keeps
exactly N in flight with no queue library.

**One bad item never fails the batch.** A failed document stays `pending`, so a
re-run picks it up without reprocessing what already succeeded.

Retries are deliberately _not_ included: retrying a stage that half-wrote is
only safe if the stage is idempotent, and whether yours is depends on your
domain. Make it idempotent, then add retries in the caller.

### The honest limitation

In-process background work loses its run on restart. Boot recovery marks it
cancelled — it does not resume. That is acceptable when stages take minutes and
are re-runnable. If yours take hours, move them to a worker process before that
becomes your outage.

## Recognition

`lib/recognition/provider_registry.js` is the seam between this application and
whatever extracts text. Everything downstream — review queue, correction
history, accuracy reporting, export — depends only on the contract, not on which
model produced the numbers. That is what lets you start on a mock, prototype
against a hosted vision API, and later self-host without touching a route, a
service or a component.

Contract rules that matter in practice:

- **`rawValue` is verbatim and `confidence` is honest.** Normalisation happens
  in a service, so "the model read 1,2OO" stays visible in the correction
  history instead of being laundered at the boundary. That history is your
  accuracy data.
- **A provider does no IO beyond reading the file.** Path in, data out. Trivially
  testable.
- **Confidence is clamped to 0–1.** A provider reporting percentages would
  otherwise auto-approve everything, because every value clears the threshold.
- **Failures degrade to "needs review"**, never to a failed batch.

The threshold decision lives in the repository, not the provider, so re-tuning
it is a config change and the same rule applies to every provider.

## Export

Declarative plans (`services/export_service.js`) rendered by a shared engine
(`lib/export/export_plan_engine.js`) into `.xlsx`
(`lib/export/xlsx_writer.js`).

Every tool like this grows a long tail of "same data, different columns, for a
different recipient". As code, each is a hundred lines only its author can
safely change, and the fifth is a copy of the fourth. As a plan, a new export is
a data literal and the rendering is tested once.

`xlsx_writer.js` is the only file that knows exceljs exists — a CSV or PDF
renderer is a sibling, not a rewrite. It streams row by row, because a 50k-row
export buffered in memory is hundreds of MB of heap at exactly the moment
several operators export at once.

## Frontend

Vue 3, Vite, Pinia, vue-router, axios. No UI kit and no CSS framework:
`frontend/src/styles/tokens.css` holds the palette, type scale, spacing and
motion, and components consume the variables. Changing the visual direction is
one file.

Three behaviours are worth knowing about:

**Deploy detection.** The server stamps every response with a per-process
`X-App-Boot`. This app stays open for days on a second monitor, so after a
deploy that tab is still running the old bundle — and a bug you fixed this
morning keeps getting reported against code that no longer exists. When the
header changes, a banner offers a reload. A _banner_, not a forced reload:
reloading out from under someone mid-correction loses their work. The passive
check only fires on a request, so the client also probes `/readyz` when the tab
becomes visible again.

**Upload and download timeouts.** The global 30s axios timeout is raised to five
minutes for `FormData` and `blob` requests. Without it, a multi-file upload on
an office uplink is killed mid-transfer and the browser reports a bare "Network
Error" — with nothing in the server log, because the request never finished
arriving.

**Only changed fields are submitted.** Sending every field would mark untouched
values as human-corrected and destroy the accuracy data the `corrected` flag
exists to collect.

Route guards mirror the server's roles, and are convenience only — they keep a
viewer from landing on a page where every button 403s. The server is the
authority and re-checks every request.

## Health and shutdown

`/healthz` is liveness: always 200 unless the event loop is wedged, in which
case the caller's timeout is the signal. **Restart on failure.**

`/readyz` runs the registered probes — database, storage writability,
recognition provider, drain state. **Drain on failure, do not restart**, or a
slow dependency becomes a crash loop.

A probe that throws marks the service not ready but never takes the endpoint
down: a broken probe must not look like a broken service.

Shutdown order (`lib/graceful_shutdown.js`): flip readiness false → stop
accepting connections and drain → run hooks in reverse registration order →
hard-exit after the grace period. Readiness first means the load balancer stops
sending work _before_ anything closes. Reverse hook order means a hook can
safely depend on anything registered before it. The hard exit means a hung
`db.close()` cannot leave a zombie holding the port.

## Testing

`node:test`, no framework. Tests run the real middleware chain, the real
migrations and a real SQLite file in a temp directory, because that is where the
bugs are: middleware ordering, a migration that fails on an empty table, a
transaction that does not roll back. A suite of mocks passes while the server
fails to boot.

`tests/helpers/test_app.js` builds a full app on an ephemeral port per test file,
so files are independent and parallel-safe.

The tests worth keeping when you rewrite the rest:

- a failed migration rolls back completely and is not recorded as applied
- a wrong username and a wrong password produce byte-identical responses
- insufficient role returns 403, not 401
- a locked batch refuses every write path and still allows reads
- every mutating route is audited, or explicitly exempt
- money totals are exact
- a successful login does not consume rate-limit budget

`tests/_stall_watchdog.mjs` dumps open handles and exits non-zero if the run
hangs — the fix for a test that leaks a server and turns CI into a 20-minute
timeout with a log ending mid-sentence.

## Things to change as you grow

Roughly in the order you will hit them.

| Signal                                                  | Change                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Write contention, `SQLITE_BUSY` under normal load       | Postgres. Every query is already in `repositories/`                                                      |
| Stages measured in hours, or restarts losing real work  | Move stage execution to a worker process with a durable queue                                            |
| More than one replica                                   | Redis-backed rate limiting; revisit the in-process advisory locks                                        |
| Someone asks for filters they can share by URL          | Move list filters into query params — see `AuditView.vue`, which currently keeps them in component state |
| Audit entries that must be transactional with the write | Move the insert into the write's transaction                                                             |
| A second front-end origin                               | CSRF tokens; do not weaken `sameSite`                                                                    |
| Compliance asks who read a document                     | Add read auditing — only writes are recorded today                                                       |
