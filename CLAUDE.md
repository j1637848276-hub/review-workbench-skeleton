# Notes for AI coding agents

Context for Claude Code, Copilot, Cursor and similar tools working in this
repository. Human contributors want `CONTRIBUTING.md` and `ARCHITECTURE.md`.

## What this is

A skeleton for an internal document-review tool: upload → recognize → human
review → export. The plumbing is complete; the business logic is intentionally
absent. When asked to "add a feature", extend the existing seams rather than
building a parallel structure beside them.

## Read first

| File                   | Why                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `ARCHITECTURE.md`      | The decisions and their reasons. Several things that look accidental are load-bearing. |
| `server/create_app.js` | Middleware order is load-bearing. Read the comment block before reordering anything.   |
| `server/container.js`  | The whole dependency graph, wired by hand.                                             |
| `lib/config.js`        | Every environment variable. Nothing else reads `process.env`.                          |

## Hard rules

These break things in ways that are not obvious from a passing test run.

1. **Never edit an applied migration.** It will not re-run. Add the next
   numbered file.
2. **A `.js` migration must not open a transaction.** The runner already did;
   nesting throws.
3. **No SQL outside `repositories/`.** No `req`/`res` inside `services/`.
4. **Use `runInTransaction`** from `lib/storage/sqlite_transaction.js`, never a
   bare `BEGIN`. It handles the nested case; a bare `COMMIT` inside an open
   transaction publishes the caller's half-finished work.
5. **Adding a mutating route means adding a row to `DEFAULT_ACTION_MAP`** in
   `lib/audit_middleware.js`. `tests/audit_and_export.test.js` fails otherwise,
   and that failure is deliberate — do not add the route to the exempt list to
   make it pass.
6. **Every write path checks the batch lock** via
   `batchRepository.assertWritable()`. A closed period must stay closed.
7. **Throw the error types in `lib/errors.js`.** Do not hand-roll
   `res.status(400).json(...)` in a service; the error middleware is the single
   exit.
8. **Money goes through `decimal.js`**, stored as TEXT. Never `REAL`, never
   float arithmetic.
9. **Never add a runtime dependency without being asked.** The short dependency
   list is a stated feature of this project.
10. **Any filesystem path derived from user input** must be resolved and checked
    against the storage root — see `documentIntakeService.resolveStoragePath`.

## Where things go

| Task                  | File                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| New table or column   | a new file in `lib/storage/migrations/`                                             |
| New query             | the matching `repositories/*.js`                                                    |
| New business rule     | `services/*.js`                                                                     |
| New endpoint          | `routes/*.js`, then wire in `server/create_app.js`                                  |
| New pipeline stage    | a service using `stageRunner.start()`; copy `services/recognition_stage_service.js` |
| New model integration | a provider in `lib/recognition/`                                                    |
| New export format     | an entry in `EXPORT_PLANS` in `services/export_service.js`                          |
| New field normaliser  | `NORMALIZERS` in `services/review_service.js`                                       |
| Visual change         | `frontend/src/styles/tokens.css` first, components second                           |

## Style

- CommonJS in the backend, ESM in `frontend/` and `e2e/`.
- Prettier settings are in `.prettierrc.json`: no semicolons, single quotes,
  100 columns. Run `npm run format`.
- `'use strict'` at the top of backend files, matching the existing files.
- Factory functions (`createThing({ deps })`), not classes, and not module-level
  singletons — that is what keeps each piece independently testable.
- **Comments explain why, not what.** This codebase is commented densely and
  deliberately: the comments record the reasoning behind non-obvious choices.
  Match that when you add code, and do not delete an explanatory comment because
  the code "looks self-evident" — it looked self-evident to whoever got it wrong.

## Verifying a change

```bash
npm run lint && npm test
```

For anything touching HTTP, use `tests/helpers/test_app.js` — it builds a real
app against a temp database on an ephemeral port. Clean up in `t.after()`; a
leaked server hangs the whole run.

To see a change in the browser:

```bash
npm start                      # terminal 1
npm --prefix frontend run dev  # terminal 2 → http://localhost:5173
```

Needs a seeded database — `node --env-file=.env scripts/seed_demo.js`.

## Do not

- Commit `.env`, anything under `storage/`, or any `*.sqlite` file
- Put a real credential, hostname or IP in an example, a test, or a comment
- Add sample scans or PDFs — `scripts/seed_demo.js` generates placeholders
  precisely so that real paperwork never ends up in a public repository
- Weaken `sameSite` on the auth cookie, or move the token out of the httpOnly
  cookie into a response body
- Serve `storage/` as a static directory
