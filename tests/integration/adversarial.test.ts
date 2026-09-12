import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { botAction, event } from '@trip/db';
import {
  authHeaders,
  createHarness,
  resetDatabase,
  tripPayload,
  type Harness,
  type TestIdentity,
} from '../support/harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await resetDatabase(harness.pool);
});

async function call(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'GET',
  url: string,
  identity: TestIdentity,
  payload?: unknown,
) {
  return harness.app.inject({
    method,
    url,
    headers: authHeaders(identity),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** An independent trip with its own member and one event. */
async function makeTrip(label: string) {
  const owner = harness.identity(label);
  const created = await call('POST', '/api/trips', owner, tripPayload());
  const tripId = created.json<{ trip: { id: string } }>().trip.id;
  const snap = await call('GET', `/api/trips/${tripId}/snapshot`, owner);
  const version = snap.json<{ calendar_version: string }>().calendar_version;

  const made = await call('POST', `/api/trips/${tripId}/events`, owner, {
    idempotency_key: randomUUID(),
    expected_calendar_version: version,
    label: 'Museum',
    local_date: '2026-10-02',
    start_minute: 600,
    end_minute: 720,
    price_cents: null,
    price_source: null,
    place: null,
  });
  const body = made.json<{ event: { id: string }; calendar_version: string }>();
  return { owner, tripId, eventId: body.event.id, version: body.calendar_version };
}

describe('cross-trip isolation', () => {
  it('will not edit an event belonging to another trip', async () => {
    const mine = await makeTrip('mine');
    const theirs = await makeTrip('theirs');

    // A real event id, but from a trip this caller is not in.
    const response = await call(
      'PATCH',
      `/api/trips/${mine.tripId}/events/${theirs.eventId}`,
      mine.owner,
      {
        idempotency_key: randomUUID(),
        expected_calendar_version: mine.version,
        label: 'Hijacked',
      },
    );
    expect(response.statusCode).toBe(404);

    const untouched = await harness.database.db
      .select()
      .from(event)
      .where(eq(event.id, theirs.eventId))
      .limit(1);
    expect(untouched[0]?.label).toBe('Museum');
  });

  it('will not set attendance on another trip event', async () => {
    const mine = await makeTrip('mine');
    const theirs = await makeTrip('theirs');
    const response = await call(
      'PUT',
      `/api/trips/${mine.tripId}/events/${theirs.eventId}/attendance/me`,
      mine.owner,
      { idempotency_key: randomUUID(), expected_calendar_version: mine.version, state: 'in' },
    );
    expect(response.statusCode).toBe(404);
  });

  it('will not attach another trip place to an event', async () => {
    const mine = await makeTrip('mine');
    const theirs = await makeTrip('theirs');

    const withPlace = await call('POST', `/api/trips/${theirs.tripId}/events`, theirs.owner, {
      idempotency_key: randomUUID(),
      expected_calendar_version: theirs.version,
      label: 'Their venue',
      local_date: '2026-10-03',
      start_minute: 600,
      end_minute: 720,
      price_cents: null,
      price_source: null,
      place: { kind: 'manual', label: 'Somewhere', coordinate: { lat: 40.44, lon: -79.99 } },
    });
    const theirPlaceId = withPlace.json<{ place: { id: string } }>().place.id;

    const response = await call('POST', `/api/trips/${mine.tripId}/events`, mine.owner, {
      idempotency_key: randomUUID(),
      expected_calendar_version: mine.version,
      label: 'Borrowed venue',
      local_date: '2026-10-02',
      start_minute: 800,
      end_minute: 860,
      price_cents: null,
      price_source: null,
      place: { kind: 'existing', place_id: theirPlaceId },
    });
    expect(response.statusCode).toBe(404);
  });

  it('will not read another trip removal history or export', async () => {
    const mine = await makeTrip('mine');
    const theirs = await makeTrip('theirs');
    expect(
      (await call('GET', `/api/trips/${theirs.tripId}/deletions`, mine.owner)).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/api/trips/${theirs.tripId}/export.ics`, mine.owner)).statusCode,
    ).toBe(404);
    expect((await call('GET', `/api/trips/${theirs.tripId}/snapshot`, mine.owner)).statusCode).toBe(
      404,
    );
  });
});

describe('stored action replay', () => {
  it('refuses a replayed action and one bound to an older revision', async () => {
    const { owner, tripId, eventId } = await makeTrip('owner');

    const inserted = await harness.database.db
      .insert(botAction)
      .values({
        tripId,
        sourceMsgId: 1n,
        type: 'remove_suggestion',
        dedupeKey: `remove:${eventId}:1`,
        targetEventId: eventId,
        expectedEventRevision: 1n,
        status: 'pending',
      })
      .returning();
    const actionId = inserted[0]?.id ?? '';

    // Editing the event moves it past the revision the action expects.
    const snap = await call('GET', `/api/trips/${tripId}/snapshot`, owner);
    const version = snap.json<{ calendar_version: string }>().calendar_version;
    await call('PATCH', `/api/trips/${tripId}/events/${eventId}`, owner, {
      idempotency_key: randomUUID(),
      expected_calendar_version: version,
      label: 'Museum, moved',
    });

    const after = await call('GET', `/api/trips/${tripId}/snapshot`, owner);
    const response = await call('POST', `/api/trips/${tripId}/actions/${actionId}`, owner, {
      idempotency_key: randomUUID(),
      expected_calendar_version: after.json<{ calendar_version: string }>().calendar_version,
      choice: 'remove',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('stale');

    // A stale action deletes nothing.
    const rows = await harness.database.db
      .select()
      .from(event)
      .where(eq(event.id, eventId))
      .limit(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  it('will not let a nonmember resolve an action', async () => {
    const { tripId, eventId } = await makeTrip('owner');
    const inserted = await harness.database.db
      .insert(botAction)
      .values({
        tripId,
        sourceMsgId: 1n,
        type: 'remove_suggestion',
        dedupeKey: `remove:${eventId}:2`,
        targetEventId: eventId,
        expectedEventRevision: 1n,
        status: 'pending',
      })
      .returning();

    const outsider = harness.identity('outsider');
    const response = await call(
      'POST',
      `/api/trips/${tripId}/actions/${inserted[0]?.id ?? ''}`,
      outsider,
      { idempotency_key: randomUUID(), expected_calendar_version: '1', choice: 'remove' },
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('secret handling', () => {
  it('never returns a provider key or a database URL in an error', async () => {
    const { owner, tripId } = await makeTrip('owner');
    const response = await call('POST', `/api/trips/${tripId}/places/search`, owner, {
      query: 'anything',
    });
    const text = response.body;
    expect(text).not.toContain('postgresql://');
    expect(text).not.toMatch(/api[_-]?key/i);
  });
});
