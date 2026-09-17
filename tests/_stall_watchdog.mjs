/**
 * Test-run watchdog, loaded via `node --test --import=./tests/_stall_watchdog.mjs`.
 *
 * Solves one specific and maddening failure: a test that opens a handle it
 * never closes — a server, a database, a timer — so the run finishes its
 * assertions and then hangs forever with no output. In CI that is a 20-minute
 * timeout and a log that ends mid-sentence.
 *
 * On expiry this prints the handles still keeping the loop alive, which is
 * almost always the answer, and exits non-zero.
 */

const TIMEOUT_MS = Number(process.env.TEST_WATCHDOG_MS || 120_000)

const watchdog = setTimeout(() => {
  process.stderr.write(`\n[watchdog] test run exceeded ${TIMEOUT_MS}ms — dumping open handles\n`)

  // Internal API, deliberately: there is no public way to ask "what is keeping
  // this process alive", and that is exactly the question. Guarded because it
  // can disappear in a future Node release without warning.
  try {
    const handles = process._getActiveHandles?.() ?? []
    const requests = process._getActiveRequests?.() ?? []
    const summary = new Map()
    for (const handle of [...handles, ...requests]) {
      const name = handle?.constructor?.name ?? typeof handle
      summary.set(name, (summary.get(name) ?? 0) + 1)
    }
    for (const [name, count] of summary) {
      process.stderr.write(`[watchdog]   ${count} x ${name}\n`)
    }
    process.stderr.write(
      '[watchdog] Usual causes: a server not closed in after(), a db handle left open,\n' +
        '[watchdog] or a setInterval without unref().\n'
    )
  } catch {
    process.stderr.write('[watchdog] handle introspection unavailable on this Node build\n')
  }

  process.exit(1)
}, TIMEOUT_MS)

// unref so the watchdog itself never keeps the process alive — otherwise it
// would guarantee the hang it exists to detect.
watchdog.unref()
