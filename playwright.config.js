// @ts-check
import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright drives the *built* app through the Express process, not the Vite
 * dev server. That is deliberate: the history-mode fallback, the static asset
 * headers and the single-origin cookie only exist in the production path, and
 * those are exactly the things that break on deploy.
 */
export default defineConfig({
  testDir: './e2e',
  // Every assertion waits on a condition, so a generous per-test budget costs
  // nothing on a green run and avoids flakes on a loaded CI machine.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Fail the run if a test was left with `.only` — otherwise a stray marker
  // silently reduces CI to one test and the build still goes green.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    // Artifacts only for failures: a trace of a passing run is a few MB of
    // nothing, and it is the failed run you need to look at.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Uncomment once the flows are stable. Cross-browser coverage is worth
    // having, and worth adding after the suite is not the thing being debugged.
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',  use: { ...devices['Desktop Safari'] } },
  ],

  // Portable command: `npm.cmd` here would work on Windows and fail on every
  // Linux CI runner. `node` plus an explicit script path works everywhere.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node --env-file=.env server.js',
        url: 'http://127.0.0.1:3000/healthz',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
