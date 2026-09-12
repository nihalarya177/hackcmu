import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTripResponse, personMutationResponse } from '@trip/contracts';
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

async function createTrip(identity: TestIdentity, payload: Record<string, unknown>) {
  return harness.app.inject({
    method: 'POST',
    url: '/api/trips',
    headers: authHeaders(identity),
    payload,
  });
}

describe('idempotent commands', () => {
  it('creates one trip when the same request is retried', async () => {
    const creator = harness.identity('creator');
    const payload = tripPayload();

    const first = await createTrip(creator, payload);
    const second = await createTrip(creator, payload);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(createTripResponse.parse(second.json()).trip.id).toBe(
      createTripResponse.parse(first.json()).trip.id,
    );

    const count = await harness.pool.query<{ count: string }>('select count(*) as count from trip');
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it('replays the identical response including the issued invite token', async () => {
    const creator = harness.identity('creator');
    const payload = tripPayload();

    const first = createTripResponse.parse((await createTrip(creator, payload)).json());
    const second = createTripResponse.parse((await createTrip(creator, payload)).json());

    expect(second.invite.token).toBe(first.invite.token);
    const invites = await harness.pool.query<{ count: string }>(
      'select count(*) as count from trip_invite',
    );
    expect(Number(invites.rows[0]?.count)).toBe(1);
  });

  it('rejects the same key used with different input', async () => {
    const creator = harness.identity('creator');
    const key = randomUUID();

    await createTrip(creator, tripPayload({ idempotency_key: key }));
    const conflicting = await createTrip(
      creator,
      tripPayload({ idempotency_key: key, trip_name: 'A different trip' }),
    );

    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json<{ error: { code: string } }>().error.code).toBe(
      'IDEMPOTENCY_KEY_CONFLICT',
    );
  });

  it('scopes keys to the auth user, so two sessions can reuse a key', async () => {
    const key = randomUUID();
    const first = await createTrip(harness.identity('a'), tripPayload({ idempotency_key: key }));
    const second = await createTrip(harness.identity('b'), tripPayload({ idempotency_key: key }));

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(createTripResponse.parse(first.json()).trip.id).not.toBe(
      createTripResponse.parse(second.json()).trip.id,
    );
  });

  it('commits exactly once when the same key is sent concurrently', async () => {
    const creator = harness.identity('creator');
    const payload = tripPayload();

    const responses = await Promise.all([
      createTrip(creator, payload),
      createTrip(creator, payload),
      createTrip(creator, payload),
    ]);

    for (const response of responses) expect(response.statusCode).toBe(201);
    const ids = new Set(responses.map((r) => createTripResponse.parse(r.json()).trip.id));
    expect(ids.size).toBe(1);

    const count = await harness.pool.query<{ count: string }>('select count(*) as count from trip');
    expect(Number(count.rows[0]?.count)).toBe(1);
  });
});

describe('expected calendar version', () => {
  it('rejects an edit prepared against an older version', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator, tripPayload())).json());

    // Move the version forward.
    await harness.app.inject({
      method: 'PATCH',
      url: `/api/trips/${created.trip.id}/people/me`,
      headers: authHeaders(creator),
      payload: {
        idempotency_key: randomUUID(),
        expected_calendar_version: created.calendar_version,
        budget_cents: 30_000,
      },
    });

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: `/api/trips/${created.trip.id}/people/me`,
      headers: authHeaders(creator),
      payload: {
        idempotency_key: randomUUID(),
        expected_calendar_version: created.calendar_version,
        budget_cents: 40_000,
      },
    });

    expect(stale.statusCode).toBe(409);
    const body = stale.json<{ error: { code: string; current_calendar_version: string } }>();
    expect(body.error.code).toBe('STALE_VERSION');
    // The current version comes back so the client can reconcile without a refetch race.
    expect(BigInt(body.error.current_calendar_version)).toBeGreaterThan(
      BigInt(created.calendar_version),
    );

    const stored = await harness.pool.query<{ budget_cents: number }>(
      'select budget_cents from person where id = $1',
      [created.self.id],
    );
    expect(stored.rows[0]?.budget_cents).toBe(30_000);
  });

  it('replays a receipt before rejecting it as stale', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator, tripPayload())).json());
    const key = randomUUID();
    const payload = {
      idempotency_key: key,
      expected_calendar_version: created.calendar_version,
      budget_cents: 30_000,
    };

    const first = personMutationResponse.parse(
      (
        await harness.app.inject({
          method: 'PATCH',
          url: `/api/trips/${created.trip.id}/people/me`,
          headers: authHeaders(creator),
          payload,
        })
      ).json(),
    );

    // Someone else advances the plan, so the original expected version is stale.
    await harness.app.inject({
      method: 'PATCH',
      url: `/api/trips/${created.trip.id}`,
      headers: authHeaders(creator),
      payload: {
        idempotency_key: randomUUID(),
        expected_calendar_version: first.calendar_version,
        trip_name: 'Renamed',
      },
    });

    // A network retry of an already-applied edit must succeed, not 409.
    const retry = await harness.app.inject({
      method: 'PATCH',
      url: `/api/trips/${created.trip.id}/people/me`,
      headers: authHeaders(creator),
      payload,
    });

    expect(retry.statusCode).toBe(200);
    expect(personMutationResponse.parse(retry.json())).toEqual(first);
  });

  it('does not bump the version for a no-op edit', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator, tripPayload())).json());

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/trips/${created.trip.id}/people/me`,
      headers: authHeaders(creator),
      payload: {
        idempotency_key: randomUUID(),
        expected_calendar_version: created.calendar_version,
        display_name: created.self.display_name,
        budget_cents: created.self.budget_cents,
      },
    });

    expect(personMutationResponse.parse(response.json()).calendar_version).toBe(
      created.calendar_version,
    );
  });
});

describe('self-only properties', () => {
  it('changes only the caller own budget, never another member budget', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator, tripPayload())).json());

    const joiner = harness.identity('joiner');
    await harness.app.inject({
      method: 'POST',
      url: '/api/trips/join',
      headers: authHeaders(joiner),
      payload: { token: created.invite.token, display_name: 'Grace', budget_cents: 15_000 },
    });

    const snapshotBefore = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${created.trip.id}/snapshot`,
      headers: authHeaders(joiner),
    });
    const version = snapshotBefore.json<{ calendar_version: string }>().calendar_version;

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/trips/${created.trip.id}/people/me`,
      headers: authHeaders(joiner),
      payload: {
        idempotency_key: randomUUID(),
        expected_calendar_version: version,
        budget_cents: 1_000,
      },
    });
    expect(response.statusCode).toBe(200);

    const rows = await harness.pool.query<{ id: string; budget_cents: number }>(
      'select id, budget_cents from person where trip_id = $1 order by color_index',
      [created.trip.id],
    );
    expect(rows.rows[0]?.budget_cents).toBe(25_000);
    expect(rows.rows[1]?.budget_cents).toBe(1_000);
  });
});
