import { expect, test } from '@playwright/test';

/**
 * Mode boundary checks against the built bundle: demo needs nothing, live uses
 * the real services, and neither substitutes for the other.
 */

test('demo opens the planner with no credentials and no backend call', async ({ page }) => {
  const authCalls: string[] = [];
  await page.route('**/auth/v1/**', (route) => {
    authCalls.push(route.request().url());
    return route.abort();
  });
  const apiCalls: string[] = [];
  await page.route('**/api/**', (route) => {
    apiCalls.push(route.request().url());
    return route.abort();
  });

  // No mode argument: demo is the default, because it depends on nothing.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Trip Planner' })).toBeVisible();
  await expect(page.getByText('Demo mode — simulated data')).toBeVisible();
  await expect(page.locator('.fc-event').first()).toBeVisible();

  expect(authCalls).toEqual([]);
  expect(apiCalls).toEqual([]);
});

test('live mode obtains a real session and reaches the API', async ({ page }) => {
  await page.goto('/?mode=live');

  // No simulated participants may appear on a live screen.
  await expect(page.getByText('Demo mode — simulated data')).toHaveCount(0);
  // A real session and a real API get as far as onboarding: there is no trip yet.
  await expect(page.getByRole('button', { name: 'Start the trip' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Ana')).toHaveCount(0);
});

test('a live failure is reported, never replaced with demo content', async ({ page }) => {
  await page.route('**/auth/v1/**', (route) => route.abort('failed'));
  await page.goto('/?mode=live');

  await expect(page.getByRole('button', { name: 'Open the demo instead' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Demo mode — simulated data')).toHaveCount(0);
  await expect(page.locator('.fc-event')).toHaveCount(0);
});
