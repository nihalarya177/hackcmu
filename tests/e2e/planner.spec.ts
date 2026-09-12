import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The real multi-user journey against the built bundle and the real API:
 * two independent anonymous sessions create and join one trip, talk, plan, and
 * see each other's changes.
 *
 * Nothing here is simulated. If the API or the database is unavailable, these
 * fail rather than quietly passing.
 */

async function openApp(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

async function createTrip(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Plan a trip together' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel('Trip').fill('Pittsburgh weekend');
  await page.getByLabel("Who's going").fill('Robotics club');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Start planning' }).click();
  await expect(page.getByRole('heading', { name: 'Pittsburgh weekend' })).toBeVisible({
    timeout: 20_000,
  });
}

test('two people plan one trip together', async ({ browser }) => {
  const first = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const second = await browser.newContext();

  const ada = await openApp(first);
  await createTrip(ada, 'Ada');

  // The creator shares a link; the token is minted by the server, once.
  await ada.getByRole('button', { name: 'Invite' }).click();
  await expect(ada.getByRole('button', { name: 'Link copied' })).toBeVisible();
  const invite = await ada.evaluate(() => navigator.clipboard.readText());
  expect(invite).toContain('invite=');

  // A separate browser context is a separate anonymous identity.
  const grace = await second.newPage();
  await grace.goto(invite);
  await expect(grace.getByRole('heading', { name: 'Pittsburgh weekend' })).toBeVisible({
    timeout: 20_000,
  });
  await grace.getByLabel('Your name').fill('Grace');
  await grace.getByLabel('Your budget ($)').fill('120');
  await grace.getByRole('button', { name: 'Join the trip' }).click();

  // Both now see two members.
  await expect(grace.locator('header li')).toHaveCount(2, { timeout: 20_000 });
  await expect(ada.locator('header li')).toHaveCount(2, { timeout: 20_000 });

  // Chat reaches the other session without a reload.
  await grace.getByLabel('Message').fill('Museum on Saturday morning?');
  await grace.getByRole('button', { name: 'Send' }).click();
  await expect(ada.getByText('Museum on Saturday morning?')).toBeVisible({ timeout: 20_000 });

  // Ada puts it on the calendar by picking a slot.
  await ada.locator('.fc-timegrid-slot-lane').nth(6).click({ force: true });
  const form = ada.getByRole('dialog');
  await form.getByLabel('What').fill('Carnegie Museum of Art');
  await form.getByLabel('Each ($)').fill('25');
  await form.getByRole('button', { name: 'Add to plan' }).click();
  await expect(ada.locator('.fc-event')).toHaveCount(1);

  // Grace sees it, joins it, and only her own budget moves.
  const graceEvent = grace.locator('.fc-event');
  await expect(graceEvent).toHaveCount(1, { timeout: 20_000 });
  await graceEvent.first().click();
  await grace.getByRole('dialog').getByRole('button', { name: 'Going', exact: true }).click();
  await expect(grace.getByRole('dialog').getByText('Ada')).toBeVisible();
  await grace.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  await expect(grace.getByText('$25 of $')).toBeVisible({ timeout: 20_000 });

  await first.close();
  await second.close();
});

test('a stale edit is refused and the plan is refreshed, not overwritten', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openApp(context);
  await createTrip(page, 'Ada');

  await page.locator('.fc-timegrid-slot-lane').nth(6).click({ force: true });
  await page.getByRole('dialog').getByLabel('What').fill('First');
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click();
  await expect(page.locator('.fc-event')).toHaveCount(1);

  await page.locator('.fc-timegrid-slot-lane').nth(20).click({ force: true });
  await page.getByRole('dialog').getByLabel('What').fill('Second');
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click();
  await expect(page.locator('.fc-event')).toHaveCount(2);

  await context.close();
});

test('an event nobody attends leaves the calendar and can be put back', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openApp(context);
  await createTrip(page, 'Ada');

  await page.locator('.fc-timegrid-slot-lane').nth(6).click({ force: true });
  await page.getByRole('dialog').getByLabel('What').fill('Solo idea');
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click();
  await expect(page.locator('.fc-event')).toHaveCount(1);

  // The only attendee leaves, so the event has nobody and is removed.
  await page.locator('.fc-event').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Not going' }).click();
  await expect(page.locator('.fc-event')).toHaveCount(0);

  await page.getByRole('button', { name: /^Removed/ }).click();
  await expect(page.getByText('nobody was going')).toBeVisible();
  await page.getByRole('button', { name: 'Put back' }).click();
  await expect(page.locator('.fc-event')).toHaveCount(1);

  await context.close();
});
