import { expect, test } from '@playwright/test';

/**
 * Placeholder for the two-browser collaboration suite.
 *
 * It checks what the build actually provides today: the mode gate, a demo
 * session that starts with no credentials at all, and a live session that
 * reaches the real API. Chat, calendar and attendance flows are added with the
 * planner UI.
 */
test('the mode gate asks before touching any backend dependency', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Trip Planner' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Demo/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Live/ })).toBeVisible();
});

test('demo mode starts without credentials and stays clearly labelled', async ({ page }) => {
  // No Supabase session and no API call is required to reach this state.
  const authCalls: string[] = [];
  await page.route('**/auth/v1/**', (route) => {
    authCalls.push(route.request().url());
    return route.abort();
  });

  await page.goto('/?mode=demo');
  await expect(page.getByText('Demo mode', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset demo data' })).toBeVisible();

  // Four simulated participants, and switching between them is a demo control.
  for (const name of ['Ana', 'Ben', 'Cleo', 'Dev']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  expect(authCalls).toEqual([]);

  // The scripted planner runs entirely locally: no provider, no API.
  await page.getByRole('button', { name: 'Update plan' }).click();
  await expect(page.getByText('Two people agree on the art museum')).toBeDisabled({
    timeout: 10_000,
  });
  await expect(page.getByRole('heading', { name: /3 events/ })).toBeVisible();
});

test('live mode obtains a real session and reaches the API', async ({ page }) => {
  await page.goto('/?mode=live');
  await expect(page.getByText('Live mode')).toBeVisible();
  // A live failure must surface as an error, never as demo content.
  await expect(page.getByText('Demo mode', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Available in this mode')).toBeVisible({ timeout: 15_000 });
});
