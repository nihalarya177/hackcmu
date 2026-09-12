import { expect, test as setup } from '@playwright/test';

/**
 * Signs in once and saves the session for the rest of the suite.
 *
 * Anonymous sign-ins are rate limited per hour per IP by the auth provider, and
 * a test that creates a fresh identity it does not actually need spends that
 * quota for nothing. Only the tests that genuinely need a second person, or
 * that deliberately destroy their session, opt out of this.
 */
const STATE = 'tests/e2e/.session.json';

setup('establish one anonymous session', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Plan a trip together' })).toBeVisible({
    timeout: 20_000,
  });
  await page.context().storageState({ path: STATE });
});
