# Review Workbench — skeleton

A starting point for building an **internal document-review tool**: operators upload
batches of scans, a model extracts fields, low-confidence results are queued for a
human, corrections are recorded with an audit trail, and the result is exported as a
spreadsheet.

This is a **skeleton, not a product**. The plumbing is complete and working; the
business logic is yours to add. It runs end to end on a fresh clone — with a mock
recognition provider, generated sample documents, and two example export formats — so
you can see the whole flow before you write a line of your own code.

```
upload  ──▶  recognize  ──▶  review queue  ──▶  approve  ──▶  export
 (files)     (provider)     (below threshold)   (human)      (.xlsx)
```

## What you get

| Area            | What is implemented                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **API**         | Express 5, layered `routes → services → repositories`, one error envelope, request ids                                                |
| **Storage**     | `node:sqlite` with forward-only versioned migrations (`.sql` and `.js`), nested-safe transactions, boot crash recovery                |
| **Auth**        | JWT in an httpOnly cookie, roles (`admin` / `reviewer` / `viewer`), scrypt hashing with no native dependency, per-IP login rate limit |
| **Audit**       | Route-table middleware writing an append-only log, plus a test that fails when a new mutating route is left uncovered                 |
| **Pipeline**    | Background stage jobs with advisory locks, idempotency keys, progress the UI can poll                                                 |
| **Recognition** | Pluggable provider interface with a deterministic mock and an HTTP adapter to wire your own model                                     |
| **Export**      | Declarative export plans → streamed `.xlsx`, money via `decimal.js`                                                                   |
| **Ops**         | `/healthz` + `/readyz` with pluggable probes, structured JSON logs, graceful shutdown, verified SQLite backups, PM2 config            |
| **Frontend**    | Vue 3 + Vite SPA: hand-written CSS design tokens, review workspace, job polling, deploy-detection banner                              |
| **Quality**     | `node:test` suite covering the paths above, Playwright e2e, ESLint + Prettier, GitHub Actions CI with secret scanning                 |

Runtime dependencies are deliberately few: `express`, `multer`, `cookie-parser`,
`jsonwebtoken`, `exceljs`, `decimal.js`. No ORM, no logging framework, no UI kit, no
native build step.

## Requirements

- **Node 22.5 or newer** — `node:sqlite` and `--env-file` both need it
- No database server, no Python, no GPU

## Quick start

```bash
git clone https://github.com/j1637848276-hub/review-workbench-skeleton.git
cd review-workbench-skeleton

npm install
cp .env.example .env
```

Generate a JWT secret and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Create the first admin — you will be prompted for the password, so it never lands in
your shell history:

```bash
node --env-file=.env scripts/manage_users.js create admin admin
```

Seed a demo batch so there is something to look at:

```bash
node --env-file=.env scripts/seed_demo.js
```

Build the SPA and start the server:

```bash
npm --prefix frontend install && npm run build:frontend
npm start
```

Open <http://127.0.0.1:3000>, sign in, and open the review queue.

For frontend work, run Vite separately — it proxies `/api` to the server, so the
session cookie stays single-origin:

```bash
npm start                      # terminal 1
npm --prefix frontend run dev  # terminal 2 → http://localhost:5173
```

## Making it yours

Six files carry almost all of the domain. Work through them in order.

**1. `lib/storage/migrations/0001_init.sql`** — the schema. `batch`, `document`,
`document_field` are generic containers; rename them and add your columns. Never edit
an applied migration; add `0003_…` instead.

**2. `lib/recognition/http_provider.js`** — the seam to your model. Two TODOs: the
request shape your service expects, and the mapping from its response to
`{ key, rawValue, confidence, bbox }`. Keep the mapping a pure function so you can
test it against captured fixtures instead of a live model.

**3. `services/review_service.js`** — the `NORMALIZERS` table. One entry per field
that needs cleaning up (thousands separators, date formats, currency codes). Each must
be total: given junk, return the junk rather than throwing.

**4. `services/export_service.js`** — the `EXPORT_PLANS` table. A new recipient format
is a data literal, not a new renderer.

**5. `lib/audit_middleware.js`** — the action table. Add a row for every mutating route
you introduce. `tests/audit_and_export.test.js` fails if you forget.

**6. `frontend/src/styles/tokens.css`** — the design tokens. Palette, type scale,
spacing and motion in one file. Change these before touching a component.

Then add your own pipeline stages. `services/recognition_stage_service.js` is the
worked example: take the lock, run with bounded concurrency, report progress, never let
one bad item fail the batch.

## Commands

```bash
npm start                  # run (migrates on boot)
npm run dev                # run with --watch
npm test                   # node:test suite
npm run test:e2e           # Playwright (needs a built frontend + seeded data)
npm run lint               # ESLint
npm run format             # Prettier, write
npm run migrate            # apply migrations without starting the server
npm run migrate -- --status
npm run users              # user administration
npm run backup             # VACUUM INTO + verify + prune
npm run build:frontend
```

## Project layout

```
server.js                  boot: validate config, migrate, listen
server/
  container.js             the dependency graph, wired by hand
  create_app.js            Express assembly — middleware order matters here
routes/                    thin: parse, delegate, shape the response
services/                  business rules, no SQL
repositories/              all SQL, one row-mapping boundary
lib/
  config.js                env parsed and validated once, at boot
  errors.js                one error type per HTTP outcome
  request_logger.js        JSON lines + request id via AsyncLocalStorage
  api_error_middleware.js  the single error exit
  audit_middleware.js      route table → audit rows
  health_routes.js         /healthz (liveness) + /readyz (readiness)
  graceful_shutdown.js     drain, then close, then exit
  uploads.js               multer config and the allow-list
  auth/                    jwt, roles, scrypt, rate limiting
  storage/                 database, migration runner, transactions
  pipeline/                advisory locks, stage runner
  recognition/             provider registry, mock, http adapter
  export/                  export plan engine, xlsx writer
scripts/                   migrate, users, backup, seed
tests/                     node:test
e2e/                       Playwright
frontend/                  Vue 3 + Vite SPA
```

`ARCHITECTURE.md` explains _why_ it is shaped this way — the decisions worth
understanding before you change them, and the ones you should change as you grow.

## Security notes

Read these before deploying anything real.

- **`.env` is gitignored. Keep it that way.** The repository ships `.env.example` with
  empty values on purpose.
- **Set `JWT_SECRET` to something you generated.** Startup refuses to proceed without
  one, and refuses a secret under 32 characters.
- **`AUTH_ENABLED=false` is a local-only escape hatch.** Config validation refuses to
  start with it off when `NODE_ENV=production`.
- **Put TLS in front of this.** The app sets HSTS and marks the cookie `Secure` when
  `AUTH_COOKIE_SECURE=true`, but it does not terminate TLS itself.
- **No Content-Security-Policy is set.** A useful CSP depends on how you serve the
  SPA; a generic one would either break the app or be theatre. Add it at your reverse
  proxy.
- **The rate limiter is in-process.** It resets on restart and multiplies by replica
  count. Move it to Redis or your proxy if either matters.
- **Documents are served through an authenticated route**, not as a static directory —
  keep it that way, and add a per-batch access check when your domain needs one.
- **`storage/` holds real documents and is gitignored.** So is `*.sqlite`.

## Choices worth knowing about

Each of these is a deliberate trade, not an oversight. They are the ones most likely to
need revisiting as your deployment grows.

- **SQLite, single process.** One file, atomic backups, no server to run. The ceiling
  is write throughput, because SQLite serialises writes. Every query lives in
  `repositories/`, so moving to Postgres is contained.
- **Background work in-process.** A restart mid-stage loses the run — boot recovery
  marks it cancelled rather than resuming it. Fine for stages that take minutes and are
  re-runnable. Move to a worker before that stops being true.
- **Polling, not websockets.** One endpoint, no connection lifecycle, works through any
  proxy.
- **scrypt, not argon2id.** argon2id is stronger; scrypt ships with Node and needs no
  C++ toolchain. The stored hash format is self-describing, so swapping is contained.
- **Hand-wired dependencies, no DI framework.** More typing, and the graph is readable
  top to bottom in one file.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it, no attribution required.

---

## 中文快速上手

这是一套**内部单据审核系统的骨架**：批量上传扫描件 → 模型识别字段 → 低置信度自动进人工
复核队列 → 人工修正留痕 → 导出 Excel。

**它是骨架，不是成品。**基础设施是完整可跑的，业务逻辑留给你填。新克隆下来就能端到端跑通
（内置 mock 识别 provider、示例造数脚本、两套示例导出格式），先看清整条链路再动手改。

### 环境要求

Node 22.5 以上（`node:sqlite` 和 `--env-file` 都要这个版本）。不需要数据库服务、不需要
Python、不需要显卡。

### 跑起来

```bash
npm install
cp .env.example .env

# 生成 JWT 密钥，填进 .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 建第一个管理员（密码交互式输入，不进 shell 历史）
node --env-file=.env scripts/manage_users.js create admin admin

# 造一批演示数据
node --env-file=.env scripts/seed_demo.js

# 构建前端并启动
npm --prefix frontend install && npm run build:frontend
npm start
```

打开 <http://127.0.0.1:3000> 登录，进「Review queue」。

前端开发时单独跑 Vite（它会把 `/api` 代理到后端，保证 cookie 同源）：

```bash
npm start                      # 终端 1
npm --prefix frontend run dev  # 终端 2
```

### 改成你自己的业务

按顺序过这六个文件，业务几乎全在这里：

| 文件                                   | 改什么                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `lib/storage/migrations/0001_init.sql` | 表结构。`batch` / `document` / `document_field` 是通用容器，改名加字段。**已应用的迁移永远不要改**，加新编号         |
| `lib/recognition/http_provider.js`     | 接你自己的识别服务。两处 TODO：请求格式、响应到 `{ key, rawValue, confidence, bbox }` 的映射                         |
| `services/review_service.js`           | `NORMALIZERS` 表：每个需要清洗的字段一条（千分位、日期格式、币种）。每个函数必须是全函数——遇到脏数据原样返回，不要抛 |
| `services/export_service.js`           | `EXPORT_PLANS` 表：加一个收件方格式 = 加一条数据字面量，不用写新的渲染器                                             |
| `lib/audit_middleware.js`              | 审计动作表：每加一个写接口就加一条。忘了的话 `tests/audit_and_export.test.js` 会红                                   |
| `frontend/src/styles/tokens.css`       | 设计 token：配色、字号、间距、动效都在这一个文件。改组件之前先改这里                                                 |

要加自己的流水线阶段，照 `services/recognition_stage_service.js` 抄：拿锁 → 限并发跑 →
上报进度 → 单条失败不拖垮整批。

### 上线前必读

- `.env` 已在 `.gitignore` 里，**别把它提交上去**
- `JWT_SECRET` 必须自己生成；不填或短于 32 位，启动直接拒绝
- `AUTH_ENABLED=false` 只能本地用；`NODE_ENV=production` 下配置校验会拒绝启动
- 前面必须挂 HTTPS。应用本身不终结 TLS
- 没有设 CSP——CSP 怎么写取决于你怎么发布前端，通用写法只会误伤或者装样子，请在反向代理层加
- 限流是进程内的：重启即清零，多副本会翻倍。在意的话换 Redis 或者挪到网关
- 单据走鉴权路由下发，不是静态目录——**保持这样**
- `storage/` 装真实单据，已被忽略；`*.sqlite` 同理

### 一些刻意的取舍

都是权衡，不是偷懒，也是随着量涨最先需要重新评估的地方：

- **SQLite 单进程**：一个文件、拷贝即备份、不用运维数据库。天花板是写吞吐（SQLite 写是串行
  的）。所有 SQL 都关在 `repositories/` 里，要换 Postgres 影响面可控
- **后台任务在进程内跑**：重启会丢当次运行（启动恢复只是把它标记成 cancelled，不会续跑）。
  阶段耗时在分钟级且可重跑时够用，超出这个范围就该挪到独立 worker
- **轮询而非 websocket**：一个接口、没有连接生命周期、穿任何代理都不出问题
- **scrypt 而非 argon2id**：argon2id 更强，但 scrypt 是 Node 自带、不需要 C++ 编译链。
  哈希格式自带参数，以后要换影响面可控

许可证 MIT，随便用，不要求署名。
