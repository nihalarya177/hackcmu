import { expect, test } from '@playwright/test';

/**
 * Placeholder for the two-browser collaboration suite.
 *
 * It checks only what the foundation actually provides: the built bundle
 * loads, reads its public configuration, and reaches the same-origin API.
 * Chat, calendar and attendance flows are added with the manual planner.
 */
test('the foundation shell loads and reaches the API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Trip Planner' })).toBeVisible();

  // Both rows are asserted: an API that answers while the browser bundle has no
  // usable configuration is not a working page.
  const session = page.locator('div', { has: page.getByText('Anonymous session') }).last();
  await expect(session.getByText('started')).toBeVisible({ timeout: 15_000 });

  const readiness = page.locator('div', { has: page.getByText('API readiness') }).last();
  await expect(readiness.getByText('ready')).toBeVisible({ timeout: 15_000 });
});
