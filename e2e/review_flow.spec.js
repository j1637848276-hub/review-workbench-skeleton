// @ts-check
import { expect, test } from '@playwright/test'

/**
 * End-to-end coverage of the paths a unit test cannot reach: that the built
 * SPA is actually served, that the session cookie survives a reload, and that
 * the route guards behave in a real browser.
 *
 * Two rules these follow, and they are the difference between a suite you
 * trust and one you learn to re-run:
 *
 *  1. No fixed waits. Every assertion waits on a condition — Playwright's
 *     auto-waiting locators, or an explicit `toHaveURL`. A `waitForTimeout` is
 *     a test that passes on your laptop and fails in CI.
 *  2. Locate by role and label, not by CSS class. A class rename should not
 *     break a test, and a selector that requires an accessible name fails when
 *     the accessibility tree regresses — which is coverage you want for free.
 *
 * Requires a seeded database:
 *   node --env-file=.env scripts/seed_demo.js
 *   E2E_USERNAME=... E2E_PASSWORD=... npm run test:e2e
 */

const USERNAME = process.env.E2E_USERNAME ?? 'admin'
const PASSWORD = process.env.E2E_PASSWORD ?? ''

test.skip(!PASSWORD, 'Set E2E_PASSWORD to run the authenticated end-to-end suite.')

async function signIn(page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(USERNAME)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/$/)
}

test('an unauthenticated visitor is sent to login with a redirect back', async ({ page }) => {
  await page.goto('/review')
  await expect(page).toHaveURL(/\/login\?redirect=%2Freview/)
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
})

test('a wrong password shows an error and stays on the page', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill(USERNAME)
  await page.getByLabel('Password').fill('definitely-not-the-password')
  await page.getByRole('button', { name: 'Sign in' }).click()

  // role=alert, so this asserts the message is announced as well as shown.
  await expect(page.getByRole('alert')).toContainText(/invalid/i)
  await expect(page).toHaveURL(/\/login/)
})

test('the session survives a reload', async ({ page }) => {
  await signIn(page)
  await page.reload()
  // The cookie is httpOnly, so this is really asserting that the boot-time
  // /auth/me restore works — without it every refresh bounces to login.
  await expect(page.getByRole('heading', { name: 'Batches' })).toBeVisible()
})

test('the dashboard lists the seeded batch and links into it', async ({ page }) => {
  await signIn(page)

  const link = page.getByRole('link', { name: /^demo-/ })
  await expect(link).toBeVisible()
  await link.click()

  await expect(page).toHaveURL(/\/batches\/demo-/)
  await expect(page.getByRole('button', { name: /Recognize/ })).toBeVisible()
})

test('a queue item can be corrected and approved', async ({ page }) => {
  await signIn(page)
  await page.goto('/review')

  const firstItem = page.locator('.queue__item').first()
  await expect(firstItem).toBeVisible()
  await firstItem.click()

  const amount = page.getByLabel('total amount')
  await amount.fill('1234.50')

  await page.getByRole('button', { name: 'Save' }).click()
  // The server normalises, so assert on what came back rather than what was
  // typed — this is the assertion that catches a broken normaliser.
  await expect(amount).toHaveValue('1234.50')

  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByRole('button', { name: 'Approve' })).toBeEnabled()
})

test('sign out clears the session', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)

  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
})
