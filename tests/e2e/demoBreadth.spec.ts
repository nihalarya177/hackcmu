import { expect, test, type Page } from '@playwright/test';

/**
 * The advanced demonstrations, against the built bundle: map, stored actions,
 * revival with Undo, and a real calendar download. Demo mode only, so nothing
 * here needs credentials.
 */

/**
 * Plays one named scenario and waits for the simulated run to finish. A second
 * request while one is in flight is a no-op, so the wait is not optional.
 */
async function playScenario(page: Page, title: RegExp): Promise<void> {
  const working = page.getByText('Reading the conversation…');
  await page.getByRole('button', { name: 'Scenarios' }).click();
  await page.getByRole('button', { name: title }).click();
  await expect(working).toBeVisible();
  await expect(working).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto('/?mode=demo');
  await expect(page.getByText('Demo mode — simulated data')).toBeVisible();
});

test('the map draws real tiles, attributed, with one marker per stop', async ({ page }) => {
  await playScenario(page, /Two people agree on the art museum/);
  await playScenario(page, /simultaneous alternative/);
  await page.getByRole('button', { name: 'Map', exact: true }).click();

  // Actual raster tiles, not an empty grey box.
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');

  await page.getByRole('button', { name: 'Sat 10 Oct' }).click();
  // The split morning: two stops, one per group.
  await expect(page.locator('path.leaflet-interactive')).toHaveCount(2);
  const stops = page.getByRole('list', { name: 'Stops on this day' });
  await expect(stops.getByText('Carnegie Museum of Art')).toBeVisible();
  await expect(stops.getByText('Duquesne Incline')).toBeVisible();
});

test('a stop two groups share is listed once, not once per branch', async ({ page }) => {
  await playScenario(page, /Two people agree on the art museum/);
  await playScenario(page, /simultaneous alternative/);
  await playScenario(page, /pricey dinner/);
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Sat 10 Oct' }).click();

  // Everyone attends the dinner from two different mornings; it is one stop.
  const stops = page.getByRole('list', { name: 'Stops on this day' });
  await expect(stops.getByText('Group dinner')).toHaveCount(1);
  await expect(stops.getByText('no location yet')).toHaveCount(1);
});

test('Remove/Keep changes nothing until pressed, then deletes once', async ({ page }) => {
  await playScenario(page, /Two people agree on the art museum/);
  await playScenario(page, /pricey dinner/);
  await playScenario(page, /suggests dropping the dinner/);

  await expect(page.getByText('Drop Group dinner?')).toBeVisible();
  // The suggestion alone leaves the calendar untouched.
  await expect(page.locator('.fc-event', { hasText: 'Group dinner' })).toBeVisible();

  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('.fc-event', { hasText: 'Group dinner' })).toHaveCount(0);
  await expect(page.getByText('Recently removed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
});

test('revival reopens the event and Undo puts it back', async ({ page }) => {
  await playScenario(page, /Two people agree on the art museum/);
  await playScenario(page, /pricey dinner/);
  await playScenario(page, /suggests dropping the dinner/);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('.fc-event', { hasText: 'Group dinner' })).toHaveCount(0);

  await playScenario(page, /brings the dinner back/);
  await expect(page.locator('.fc-event', { hasText: 'Group dinner' })).toBeVisible();

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.fc-event', { hasText: 'Group dinner' })).toHaveCount(0);
});

test('a removed event can be restored from the history panel', async ({ page }) => {
  await playScenario(page, /Two people agree on the art museum/);
  const museum = page.locator('.fc-event', { hasText: 'Carnegie Museum of Art' });
  await museum.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();

  await expect(museum).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore' }).first().click();
  await expect(page.locator('.fc-event', { hasText: 'Carnegie Museum of Art' })).toBeVisible();
});

test('a venue correction is recorded as a human override and raises a warning', async ({
  page,
}) => {
  await page.locator('.fc-event', { hasText: 'Phipps Conservatory' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Hours for this day are unknown.')).toBeVisible();

  await dialog.getByRole('button', { name: 'Correct this venue' }).click();
  await dialog.getByLabel('Closed on this day').check();
  await dialog.getByRole('button', { name: 'Save correction' }).click();

  await expect(dialog.getByText('Recorded as closed this day.')).toBeVisible();
  await expect(dialog.getByText('corrected by a person')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText(/venue recorded as closed/)).toBeVisible();
});

test('each person downloads their own calendar file', async ({ page }) => {
  await playScenario(page, /Two people agree on the art museum/);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'My calendar' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('ana-trip.ics');

  await page.getByRole('button', { name: 'Cleo', exact: true }).click();
  const second = page.waitForEvent('download');
  await page.getByRole('button', { name: 'My calendar' }).click();
  expect((await second).suggestedFilename()).toBe('cleo-trip.ics');
});
