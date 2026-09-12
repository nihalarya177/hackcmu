import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  attendanceMutationResponse,
  eventMutationResponse,
  snapshotResponse,
  type SnapshotResponse,
} from '@trip/contracts';
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

const key = (): string => randomUUID();

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

/** A trip with two real members, each with their own anonymous session. */
async function twoPersonTrip() {
  const owner = harness.identity('owner');
  const guest = harness.identity('guest');

  const created = await call('POST', '/api/trips', owner, tripPayload());
  expect(created.statusCode).toBe(201);
  const trip = created.json<{
    trip: { id: string };
    invite: { token: string };
    calendar_version: string;
  }>();

  const joined = await call('POST', '/api/trips/join', guest, {
    token: trip.invite.token,
    display_name: 'Grace',
    budget_cents: 12_000,
  });
  expect(joined.statusCode).toBe(200);

  return { owner, guest, tripId: trip.trip.id };
}

async function snapshot(identity: TestIdentity, tripId: string): Promise<SnapshotResponse> {
  const response = await call('GET', `/api/trips/${tripId}/snapshot`, identity);
  expect(response.statusCode).toBe(200);
  return snapshotResponse.parse(response.json());
}

async function addEvent(
  identity: TestIdentity,
  tripId: string,
  version: string,
  overrides: Record<string, unknown> = {},
) {
  return call('POST', `/api/trips/${tripId}/events`, identity, {
    idempotency_key: key(),
    expected_calendar_version: version,
    label: 'Carnegie Museum of Art',
    local_date: '2026-10-02',
    start_minute: 600,
    end_minute: 720,
    price_cents: 2500,
    price_source: 'confirmed',
    place: null,
    ...overrides,
  });
}

describe('manual event commands', () => {
  it('creates an event, opts the author in, and locks its schedule', async () => {
    const { owner, tripId } = await twoPersonTrip();
    const before = await snapshot(owner, tripId);

    const response = await addEvent(owner, tripId, before.calendar_version);
    expect(response.statusCode).toBe(201);
    const created = eventMutationResponse.parse(response.json());

    expect(created.event.created_by).toBe('human');
    expect(created.event.schedule_locked_by_human).toBe(true);
    // Instants are derived server-side: 10:00 in New York on 2 October is 14:00 UTC.
    expect(created.event.starts_at).toBe('2026-10-02T14:00:00.000Z');
    expect(created.attendance).toEqual([
      expect.objectContaining({ person_id: before.self_person_id, state: 'in', set_by: 'human' }),
    ]);

    const after = await snapshot(owner, tripId);
    expect(after.events).toHaveLength(1);
    expect(BigInt(after.calendar_version)).toBeGreaterThan(BigInt(before.calendar_version));
  });

  it('rejects an edit that names a stale version and reports the current one', async () => {
    const { owner, tripId } = await twoPersonTrip();
    const before = await snapshot(owner, tripId);
    await addEvent(owner, tripId, before.calendar_version);

    const stale = await addEvent(owner, tripId, before.calendar_version, { label: 'Second' });
    expect(stale.statusCode).toBe(409);
    const body = stale.json<{ error: { code: string; current_calendar_version: string } }>();
    expect(body.error.code).toBe('STALE_VERSION');
    expect(body.error.current_calendar_version).not.toBe(before.calendar_version);

    // The rejected command left nothing behind.
    expect((await snapshot(owner, tripId)).events).toHaveLength(1);
  });

  it('replays an identical retry instead of creating a second event', async () => {
    const { owner, tripId } = await twoPersonTrip();
    const version = (await snapshot(owner, tripId)).calendar_version;
    const payload = {
      idempotency_key: key(),
      expected_calendar_version: version,
      label: 'Incline',
      local_date: '2026-10-02',
      start_minute: 600,
      end_minute: 720,
      price_cents: null,
      price_source: null,
      place: null,
    };

    const first = await call('POST', `/api/trips/${tripId}/events`, owner, payload);
    const retry = await call('POST', `/api/trips/${tripId}/events`, owner, payload);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.json<{ event: { id: string } }>().event.id).toBe(
      first.json<{ event: { id: string } }>().event.id,
    );
    expect((await snapshot(owner, tripId)).events).toHaveLength(1);
  });

  it('refuses a fourth simultaneous event and preserves the first three', async () => {
    const { owner, tripId } = await twoPersonTrip();
    let version = (await snapshot(owner, tripId)).calendar_version;

    for (const label of ['One', 'Two', 'Three']) {
      const response = await addEvent(owner, tripId, version, { label });
      expect(response.statusCode).toBe(201);
      version = response.json<{ calendar_version: string }>().calendar_version;
    }

    const fourth = await addEvent(owner, tripId, version, { label: 'Four' });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json<{ error: { code: string } }>().error.code).toBe('CAPACITY_EXCEEDED');

    const after = await snapshot(owner, tripId);
    expect(after.events).toHaveLength(3);
    expect(after.calendar_version).toBe(version);
  });

  it('rejects a local time the clocks skip', async () => {
    const owner = harness.identity('owner');
    const created = await call(
      'POST',
      '/api/trips',
      owner,
      tripPayload({ start_date: '2026-03-08', end_date: '2026-03-08' }),
    );
    const tripId = created.json<{ trip: { id: string } }>().trip.id;
    const version = (await snapshot(owner, tripId)).calendar_version;

    // 02:30 does not exist on the US spring-forward date.
    const response = await addEvent(owner, tripId, version, {
      local_date: '2026-03-08',
      start_minute: 150,
      end_minute: 240,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      'does not exist',
    );
  });

  it('rejects a date outside the trip', async () => {
    const { owner, tripId } = await twoPersonTrip();
    const version = (await snapshot(owner, tripId)).calendar_version;
    const response = await addEvent(owner, tripId, version, { local_date: '2026-11-30' });
    expect(response.statusCode).toBe(422);
  });
});

describe('self-only attendance', () => {
  it('lets a member join and leave, and deletes an event nobody attends', async () => {
    const { owner, guest, tripId } = await twoPersonTrip();
    let version = (await snapshot(owner, tripId)).calendar_version;
    const created = await addEvent(owner, tripId, version);
    const eventId = created.json<{ event: { id: string } }>().event.id;
    version = created.json<{ calendar_version: string }>().calendar_version;

    const joinIn = await call(
      'PUT',
      `/api/trips/${tripId}/events/${eventId}/attendance/me`,
      guest,
      { idempotency_key: key(), expected_calendar_version: version, state: 'in' },
    );
    expect(joinIn.statusCode).toBe(200);
    const joined = attendanceMutationResponse.parse(joinIn.json());
    expect(joined.attendance).toHaveLength(2);
    version = joined.calendar_version;

    // Both leave; the event has nobody left and is removed automatically.
    const ownerOut = await call(
      'PUT',
      `/api/trips/${tripId}/events/${eventId}/attendance/me`,
      owner,
      { idempotency_key: key(), expected_calendar_version: version, state: 'out' },
    );
    version = ownerOut.json<{ calendar_version: string }>().calendar_version;

    const guestOut = await call(
      'PUT',
      `/api/trips/${tripId}/events/${eventId}/attendance/me`,
      guest,
      { idempotency_key: key(), expected_calendar_version: version, state: 'out' },
    );
    expect(attendanceMutationResponse.parse(guestOut.json()).event).toBeNull();

    const after = await snapshot(owner, tripId);
    expect(after.events).toHaveLength(0);
    const removal = after.recent_deletions.find((row) => row.event_id === eventId);
    expect(removal?.reason).toBe('auto_zero_attendance');
    // An automatic removal leaves no tombstone, so the visit can be planned again.
    expect(removal?.tombstone_id).toBeNull();
  });

  it('refuses to change attendance for a trip the caller is not in', async () => {
    const { owner, tripId } = await twoPersonTrip();
    const version = (await snapshot(owner, tripId)).calendar_version;
    const created = await addEvent(owner, tripId, version);
    const eventId = created.json<{ event: { id: string } }>().event.id;

    const outsider = harness.identity('outsider');
    const response = await call(
      'PUT',
      `/api/trips/${tripId}/events/${eventId}/attendance/me`,
      outsider,
      {
        idempotency_key: key(),
        expected_calendar_version: created.json<{ calendar_version: string }>().calendar_version,
        state: 'in',
      },
    );
    // A nonmember is told the trip does not exist rather than that it does.
    expect(response.statusCode).toBe(404);
  });
});

describe('derived state', () => {
  it('reports budgets, unknown prices and an overspend warning', async () => {
    const { owner, guest, tripId } = await twoPersonTrip();
    let version = (await snapshot(owner, tripId)).calendar_version;

    // Grace has a 120.00 budget; this alone puts her over it.
    const pricey = await addEvent(owner, tripId, version, {
      label: 'Tasting menu',
      start_minute: 1140,
      end_minute: 1290,
      price_cents: 18_000,
      price_source: 'confirmed',
    });
    version = pricey.json<{ calendar_version: string }>().calendar_version;
    const eventId = pricey.json<{ event: { id: string } }>().event.id;

    const joinIn = await call(
      'PUT',
      `/api/trips/${tripId}/events/${eventId}/attendance/me`,
      guest,
      { idempotency_key: key(), expected_calendar_version: version, state: 'in' },
    );
    version = joinIn.json<{ calendar_version: string }>().calendar_version;

    const after = await snapshot(guest, tripId);
    const graceBudget = after.budgets.find((row) => row.person_id === after.self_person_id);
    expect(graceBudget?.known_spend_cents).toBe(18_000);
    expect(graceBudget?.status).toBe('over');

    const overspend = after.warnings.filter((row) => row.kind === 'budget_exceeded' && row.active);
    expect(overspend).toHaveLength(1);
    expect(overspend[0]?.person_id).toBe(after.self_person_id);

    // Leaving clears it, and the warning is resolved rather than deleted.
    const leave = await call('PUT', `/api/trips/${tripId}/events/${eventId}/attendance/me`, guest, {
      idempotency_key: key(),
      expected_calendar_version: version,
      state: 'out',
    });
    expect(leave.statusCode).toBe(200);

    const cleared = await snapshot(guest, tripId);
    const resolved = cleared.warnings.find((row) => row.kind === 'budget_exceeded');
    expect(resolved?.active).toBe(false);
    expect(resolved?.resolved_at_version).not.toBeNull();
  });

  it('distinguishes a known zero price from an unknown one', async () => {
    const { owner, tripId } = await twoPersonTrip();
    let version = (await snapshot(owner, tripId)).calendar_version;

    const free = await addEvent(owner, tripId, version, {
      label: 'Point State Park',
      price_cents: 0,
      price_source: 'confirmed',
    });
    version = free.json<{ calendar_version: string }>().calendar_version;
    const unknown = await addEvent(owner, tripId, version, {
      label: 'Wander the Strip',
      start_minute: 800,
      end_minute: 900,
      price_cents: null,
      price_source: null,
    });
    expect(unknown.statusCode).toBe(201);

    const after = await snapshot(owner, tripId);
    const budget = after.budgets.find((row) => row.person_id === after.self_person_id);
    expect(budget?.known_spend_cents).toBe(0);
    expect(budget?.unknown_price_event_count).toBe(1);
    expect(budget?.status).toBe('unknown');
    expect(after.unknown_coverage.unknown_price_event_ids).toEqual([
      unknown.json<{ event: { id: string } }>().event.id,
    ]);
  });

  it('raises a double booking for one person, not for the trip', async () => {
    const { owner, guest, tripId } = await twoPersonTrip();
    let version = (await snapshot(owner, tripId)).calendar_version;

    const first = await addEvent(owner, tripId, version, { label: 'Museum' });
    version = first.json<{ calendar_version: string }>().calendar_version;
    const second = await addEvent(owner, tripId, version, {
      label: 'Incline',
      start_minute: 660,
      end_minute: 780,
    });
    expect(second.statusCode).toBe(201);

    const after = await snapshot(owner, tripId);
    const clashes = after.warnings.filter((row) => row.kind === 'double_booking' && row.active);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]?.person_id).toBe(after.self_person_id);
    // Grace attends neither, so nothing is reported against her.
    const grace = (await snapshot(guest, tripId)).self_person_id;
    expect(clashes[0]?.person_id).not.toBe(grace);
  });

  it('builds one day path per trip date, with idle members named', async () => {
    const { owner, tripId } = await twoPersonTrip();
    const version = (await snapshot(owner, tripId)).calendar_version;
    await addEvent(owner, tripId, version);

    const after = await snapshot(owner, tripId);
    expect(after.day_paths.map((day) => day.date)).toEqual(after.trip.dates);

    const first = after.day_paths.find((day) => day.date === '2026-10-02');
    expect(first?.nodes).toHaveLength(1);
    // No venue means no coordinates, so the stop is honestly unresolved.
    expect(first?.nodes[0]?.unresolved).toBe(true);
    expect(first?.idle_member_ids).toHaveLength(1);
  });
});

describe('deletion and restore', () => {
  it('writes a tombstone on human deletion and restores under the original id', async () => {
    const { owner, tripId } = await twoPersonTrip();
    let version = (await snapshot(owner, tripId)).calendar_version;
    const created = await addEvent(owner, tripId, version);
    const eventId = created.json<{ event: { id: string } }>().event.id;
    version = created.json<{ calendar_version: string }>().calendar_version;

    const deleted = await call('DELETE', `/api/trips/${tripId}/events/${eventId}`, owner, {
      idempotency_key: key(),
      expected_calendar_version: version,
    });
    expect(deleted.statusCode).toBe(200);
    const body = deleted.json<{ calendar_version: string; deleted: { tombstone_id: string } }>();
    expect(body.deleted.tombstone_id).not.toBeNull();
    version = body.calendar_version;

    const gone = await snapshot(owner, tripId);
    expect(gone.events).toHaveLength(0);
    expect(gone.recent_deletions[0]?.reason).toBe('human');

    const restored = await call('POST', `/api/trips/${tripId}/events/${eventId}/restore`, owner, {
      idempotency_key: key(),
      expected_calendar_version: version,
      tombstone_id: null,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ event: { id: string } }>().event.id).toBe(eventId);

    const back = await snapshot(owner, tripId);
    expect(back.events).toHaveLength(1);
    expect(back.recent_deletions).toHaveLength(0);
  });

  it('pages the removal history', async () => {
    const { owner, tripId } = await twoPersonTrip();
    let version = (await snapshot(owner, tripId)).calendar_version;

    for (const label of ['A', 'B', 'C']) {
      const created = await addEvent(owner, tripId, version, { label, start_minute: 600 });
      const id = created.json<{ event: { id: string } }>().event.id;
      version = created.json<{ calendar_version: string }>().calendar_version;
      const removed = await call('DELETE', `/api/trips/${tripId}/events/${id}`, owner, {
        idempotency_key: key(),
        expected_calendar_version: version,
      });
      version = removed.json<{ calendar_version: string }>().calendar_version;
    }

    const page = await call('GET', `/api/trips/${tripId}/deletions?limit=2`, owner);
    expect(page.statusCode).toBe(200);
    const body = page.json<{ items: unknown[]; has_more: boolean; next_cursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).not.toBeNull();
  });
});

describe('manual venue correction', () => {
  it('records coordinates and exact-date hours as a human override', async () => {
    const { owner, tripId } = await twoPersonTrip();
    let version = (await snapshot(owner, tripId)).calendar_version;

    const created = await addEvent(owner, tripId, version, {
      place: { kind: 'manual', label: 'Carnegie Museum of Art', coordinate: null },
    });
    version = created.json<{ calendar_version: string }>().calendar_version;
    const placeId = created.json<{ place: { id: string } }>().place.id;

    const unresolved = await snapshot(owner, tripId);
    expect(unresolved.unknown_coverage.unresolved_place_event_ids).toHaveLength(1);
    expect(unresolved.unknown_coverage.unknown_hours_event_ids).toHaveLength(1);

    const corrected = await call('PATCH', `/api/trips/${tripId}/places/${placeId}`, owner, {
      idempotency_key: key(),
      expected_calendar_version: version,
      choice: {
        kind: 'manual',
        coordinate: { lat: 40.44369, lon: -79.948976 },
        // The visit runs 10:00-12:00, so this closes before it ends.
        hours_days: [{ date: '2026-10-02', intervals: [{ start_minute: 600, end_minute: 660 }] }],
      },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json<{ place: { human_override: boolean } }>().place.human_override).toBe(
      true,
    );

    const after = await snapshot(owner, tripId);
    expect(after.unknown_coverage.unresolved_place_event_ids).toHaveLength(0);
    expect(after.unknown_coverage.unknown_hours_event_ids).toHaveLength(0);
    const hours = after.warnings.find((row) => row.kind === 'outside_opening_hours' && row.active);
    expect(hours).toBeDefined();
    if (hours?.kind === 'outside_opening_hours') {
      expect(hours.details.provenance).toBe('human');
    }
    // The day path now has a real position for that stop.
    const day = after.day_paths.find((entry) => entry.date === '2026-10-02');
    expect(day?.nodes[0]?.unresolved).toBe(false);
  });

  it('refuses a search result reference it never issued', async () => {
    const { owner, tripId } = await twoPersonTrip();
    const version = (await snapshot(owner, tripId)).calendar_version;
    const response = await addEvent(owner, tripId, version, {
      place: { kind: 'candidate', candidate_ref: 'not-a-real-reference' },
    });
    // An unknown or expired reference is refused; nothing is fabricated from it.
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNPROCESSABLE');
  });

  it('reports place search as unavailable rather than failing when disabled', async () => {
    const { owner, tripId } = await twoPersonTrip();
    const response = await call('POST', `/api/trips/${tripId}/places/search`, owner, {
      query: 'Carnegie Museum of Art',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ provider_unavailable: boolean; candidates: unknown[] }>();
    // Manual entry still works, so this is reported, not thrown.
    expect(body.provider_unavailable).toBe(true);
    expect(body.candidates).toEqual([]);
  });
});

describe('calendar export', () => {
  it('gives each person only their own attended events', async () => {
    const { owner, guest, tripId } = await twoPersonTrip();
    let version = (await snapshot(owner, tripId)).calendar_version;

    const mine = await addEvent(owner, tripId, version, { label: 'Museum visit' });
    version = mine.json<{ calendar_version: string }>().calendar_version;
    await addEvent(owner, tripId, version, {
      label: 'Solo walk',
      start_minute: 900,
      end_minute: 960,
    });

    const ownerFile = await call('GET', `/api/trips/${tripId}/export.ics`, owner);
    expect(ownerFile.statusCode).toBe(200);
    expect(ownerFile.headers['content-type']).toContain('text/calendar');
    expect(ownerFile.body).toContain('BEGIN:VCALENDAR');
    expect(ownerFile.body).toContain('Museum visit');
    // 10:00 in New York on 2 October is 14:00 UTC, written absolutely.
    expect(ownerFile.body).toContain('DTSTART:20261002T140000Z');

    // Grace attends neither, so her calendar is empty rather than everyone's.
    const guestFile = await call('GET', `/api/trips/${tripId}/export.ics`, guest);
    expect(guestFile.statusCode).toBe(200);
    expect(guestFile.body).not.toContain('Museum visit');
    expect(guestFile.body).not.toContain('Solo walk');
  });

  it('refuses to export a trip the caller is not in', async () => {
    const { tripId } = await twoPersonTrip();
    const outsider = harness.identity('outsider');
    const response = await call('GET', `/api/trips/${tripId}/export.ics`, outsider);
    expect(response.statusCode).toBe(404);
  });
});
