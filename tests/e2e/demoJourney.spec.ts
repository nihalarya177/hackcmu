import { expect, test, type Page } from '@playwright/test';

/**
 * The presentation journey, end to end against the built bundle:
 * four-person trip -> agreement -> Update plan -> event -> attendance change
 * -> budget update.
 *
 * It runs entirely in demo mode, so it needs no credentials, no API and no
 * database.
 */

/** The budget card for one participant, read from the left panel. */
function budgetCard(page: Page, name: string) {
  return page.locator('aside li').filter({ hasText: name }).first();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mode=demo');
  await expect(page.getByText('Demo mode — simulated data')).toBeVisible();
});

test('the planner is the first screen, showing the four-person trip', async ({ page }) => {
  // No mode chooser stands between the viewer and the product.
  await expect(page.getByRole('heading', { name: 'Trip Planner' })).toBeVisible();

  for (const name of ['Ana', 'Ben', 'Cleo', 'Dev']) {
    await expect(budgetCard(page, name)).toBeVisible();
  }
  await expect(budgetCard(page, 'Ana')).toContainText('of $400');
  await expect(budgetCard(page, 'Ben')).toContainText('of $120');

  // The seeded plan is already on the calendar.
  await expect(page.locator('.fc-event', { hasText: 'Walk out to the Point' })).toBeVisible();
});

test('agreement becomes an event, and the attendance change moves a budget', async ({ page }) => {
  await expect(budgetCard(page, 'Cleo')).toContainText('$20 of $600');

  // 1. Agreement: add a line to the two already in the transcript.
  await page.getByLabel('Message').fill('Yes, museum Saturday morning works.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Yes, museum Saturday morning works.')).toBeVisible();
  // A sent message clears the draft; an unsent one would have been kept.
  await expect(page.getByLabel('Message')).toHaveValue('');

  // 2. Update plan: the run is visible while it happens.
  await page.getByRole('button', { name: 'Update plan' }).click();
  await expect(page.getByText('Reading the conversation…')).toBeVisible();

  // 3. An event appears, and the planner says what it did.
  const museum = page.locator('.fc-event', { hasText: 'Carnegie Museum of Art' });
  await expect(museum).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Ana and Ben both asked for/)).toBeVisible();
  await expect(budgetCard(page, 'Ana')).toContainText('$25 of $400');

  // 4. Attendance change, made as somebody else.
  await page.getByRole('button', { name: 'Cleo', exact: true }).click();
  await museum.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Carnegie Museum of Art' })).toBeVisible();
  await dialog.getByRole('button', { name: 'in', exact: true }).click();

  // 5. The roster and the budget agree, without a reload.
  await expect(dialog.getByRole('list').filter({ hasText: 'Cleo' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(budgetCard(page, 'Cleo')).toContainText('$45 of $600');
});

test('overspend is visible in the budget panel and the warning list', async ({ page }) => {
  await page.getByRole('button', { name: 'Update plan' }).click();
  await expect(page.locator('.fc-event', { hasText: 'Carnegie Museum of Art' })).toBeVisible({
    timeout: 10_000,
  });

  // Ben joins an expensive dinner he cannot afford.
  await page.getByRole('button', { name: 'Ben', exact: true }).click();
  await page.getByRole('button', { name: 'Add event' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Tasting menu');
  await dialog.getByLabel('Day').selectOption('2026-10-10');
  await dialog.getByLabel('Start').fill('19:00');
  await dialog.getByLabel('End').fill('21:30');
  await dialog.getByLabel(/Price per person/).fill('180');
  await dialog.getByRole('button', { name: 'Add event' }).click();

  await expect(budgetCard(page, 'Ben')).toContainText('over');
  await expect(page.getByText(/is over budget/)).toBeVisible();
});

test('an unsent draft survives switching between chat and calendar', async ({ page }) => {
  // Narrow enough that the two are behind tabs.
  await page.setViewportSize({ width: 480, height: 900 });
  await page.getByLabel('Message').fill('half-written thought');

  await page.getByRole('button', { name: 'calendar' }).click();
  await expect(page.locator('.fc-view-harness')).toBeVisible();
  await page.getByRole('button', { name: 'chat' }).click();

  await expect(page.getByLabel('Message')).toHaveValue('half-written thought');
});
