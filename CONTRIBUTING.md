# Contributing

This is a skeleton, so the most useful contributions keep it a skeleton:
plumbing that every fork would otherwise write itself, and clearer explanations
of the decisions. Domain-specific features generally belong in your fork, not
here.

## Good contributions

- Bug fixes, especially in the auth, migration or transaction paths
- A test that pins down behaviour the code already promises
- A recognition provider adapter for a widely-used service
- A renderer alongside `xlsx_writer.js` (CSV, PDF) behind the same engine
- Documentation that explains _why_, not what the code already says
- Removing a dependency, or a subtle platform incompatibility

## Probably not

- A UI kit, a CSS framework, an ORM, a logging framework. The lean dependency
  list is a feature — see `ARCHITECTURE.md`.
- Business logic for a specific industry. Fork it.
- Broad reformatting. Prettier owns formatting; a style rewrite makes the
  history unreadable for everyone.

## Setup

```bash
npm install
npm --prefix frontend install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # → JWT_SECRET
node --env-file=.env scripts/manage_users.js create admin admin
node --env-file=.env scripts/seed_demo.js
npm run build:frontend
npm start
```

## Before you open a PR

```bash
npm run lint
npm run format
npm test
```

CI runs the same three plus a frontend build, and scans for committed secrets.

## Conventions

- **Commits**: `type: subject` — `feat`, `fix`, `refactor`, `docs`, `test`,
  `chore`, `perf`, `ci`. Imperative subject, no trailing period.
- **Layering**: routes parse and delegate; services hold rules and never see
  `req`; repositories hold all the SQL. A service that takes `req` will be sent
  back.
- **Comments explain why.** A comment restating the code is noise; a comment
  explaining a non-obvious decision is the most valuable line in the file. If
  something looks odd and is correct, say why — that is what stops the next
  person "fixing" it.
- **No new runtime dependency without a reason in the PR description.** Dev
  dependencies are an easier sell.

## Migrations

- Add a new numbered file; **never edit an applied one.** It will not re-run, so
  environments silently diverge.
- `.sql` for plain DDL, `.js` when you need to read data (a backfill, a
  conditional column add).
- A `.js` migration must not open a transaction — the runner already did.
- Guard `ALTER TABLE ADD COLUMN` with a `pragma_table_info` check; SQLite has no
  `IF NOT EXISTS` for columns. See `0002_document_page_number.js`.

## Tests

- `node:test` and `node:assert/strict`. No framework.
- Use `tests/helpers/test_app.js` for anything touching HTTP. It builds a real
  app on a temp database and an ephemeral port.
- Always clean up in `t.after()`. A leaked server hangs the whole run — the
  watchdog will tell you which handle, but the fix is yours.
- Test behaviour, not implementation. Assert on the response and the stored
  state, not on which internal function was called.
- Adding a mutating route? `tests/audit_and_export.test.js` will fail until it
  is audited. That failure is the feature.

## Security

Found something exploitable? **Open a private security advisory** on the
repository rather than a public issue, and give a reasonable window before
disclosing.

Things to be careful about in review, because they are the ones that have been
wrong before:

- Any path built from user input — it must be resolved and checked against the
  storage root
- Any new static directory — documents must stay behind an authenticated route
- Anything added to a log line or an audit `details` blob
- Any change that makes the login path's failure modes distinguishable
