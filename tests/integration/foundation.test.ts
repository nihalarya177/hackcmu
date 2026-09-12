import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTripResponse,
  invitePreviewResponse,
  joinTripResponse,
  snapshotResponse,
  TRIP_LIMITS,
} from '@trip/contracts';
import {
  authHeaders,
  createHarness,
  resetDatabase,
  tripPayload,
  type Harness,
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

async function createTrip(token: string, overrides: Record<string, unknown> = {}) {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/trips',
    headers: authHeaders({ authUserId: '', token }),
    payload: tripPayload(overrides),
  });
  return response;
}

describe('anonymous identity and membership', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/trips',
      payload: tripPayload(),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a token the auth provider does not recognise', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/trips',
      headers: { authorization: 'Bearer not-a-real-token' },
      payload: tripPayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates a trip, its creator membership and an invite atomically', async () => {
    const creator = harness.identity('creator');
    const response = await createTrip(creator.token);

    expect(response.statusCode).toBe(201);
    const body = createTripResponse.parse(response.json());

    expect(body.self.color_index).toBe(0);
    expect(body.trip.creator_person_id).toBe(body.self.id);
    expect(body.members).toHaveLength(1);
    expect(body.calendar_version).toBe('0');
    expect(body.trip.dates).toEqual(['2026-10-02', '2026-10-03', '2026-10-04']);
    expect(body.trip.currency).toBe('USD');
    expect(body.invite.token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  });

  it('never stores the invite token itself', async () => {
    const creator = harness.identity('creator');
    const body = createTripResponse.parse((await createTrip(creator.token)).json());

    const stored = await harness.pool.query<{ token_hash: Buffer }>(
      'select token_hash from trip_invite',
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]?.token_hash.toString('utf8')).not.toContain(body.invite.token);
  });

  it('rejects a trip longer than the supported span', async () => {
    const creator = harness.identity('creator');
    const response = await createTrip(creator.token, { end_date: '2026-10-09' });
    expect(response.statusCode).toBe(422);
  });

  it('shows an invite holder only names, dates and availability', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator.token)).json());

    const joiner = harness.identity('joiner');
    const preview = await harness.app.inject({
      method: 'POST',
      url: '/api/invites/preview',
      headers: authHeaders(joiner),
      payload: { token: created.invite.token },
    });

    expect(preview.statusCode).toBe(200);
    const body = invitePreviewResponse.parse(preview.json());
    expect(body.join_available).toBe(true);
    // An invite holder is not a member yet and must learn nothing about them.
    expect(Object.keys(preview.json<object>()).sort()).toEqual([
      'destination_label',
      'end_date',
      'group_name',
      'join_available',
      'start_date',
      'trip_name',
      'unavailable_reason',
    ]);
  });

  it('assigns the first unused palette index on join and bumps the version', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator.token)).json());

    const joiner = harness.identity('joiner');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/trips/join',
      headers: authHeaders(joiner),
      payload: { token: created.invite.token, display_name: 'Grace', budget_cents: 15_000 },
    });

    expect(response.statusCode).toBe(200);
    const body = joinTripResponse.parse(response.json());
    expect(body.already_member).toBe(false);
    expect(body.self.color_index).toBe(1);
    // The joiner is not the creator, so the UI can hide invite rotation.
    expect(body.trip.creator_person_id).not.toBe(body.self.id);
    expect(body.members).toHaveLength(2);
    expect(BigInt(body.calendar_version)).toBeGreaterThan(BigInt(created.calendar_version));
  });

  it('returns the existing membership when the same session reopens an invite', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator.token)).json());
    const joiner = harness.identity('joiner');
    const payload = { token: created.invite.token, display_name: 'Grace', budget_cents: 15_000 };

    const first = joinTripResponse.parse(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/api/trips/join',
          headers: authHeaders(joiner),
          payload,
        })
      ).json(),
    );
    const second = joinTripResponse.parse(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/api/trips/join',
          headers: authHeaders(joiner),
          payload: { ...payload, display_name: 'Grace again' },
        })
      ).json(),
    );

    expect(second.already_member).toBe(true);
    expect(second.self.id).toBe(first.self.id);
    expect(second.self.color_index).toBe(first.self.color_index);
    expect(second.members).toHaveLength(2);
  });

  it('does not let a matching display name recover another person membership', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator.token)).json());
    const payload = { token: created.invite.token, display_name: 'Grace', budget_cents: 15_000 };

    const first = joinTripResponse.parse(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/api/trips/join',
          headers: authHeaders(harness.identity('device-a')),
          payload,
        })
      ).json(),
    );
    // A new device is a new identity, even with an identical name.
    const second = joinTripResponse.parse(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/api/trips/join',
          headers: authHeaders(harness.identity('device-b')),
          payload,
        })
      ).json(),
    );

    expect(second.self.id).not.toBe(first.self.id);
    expect(second.self.color_index).not.toBe(first.self.color_index);
  });

  it('stops joins at the member limit', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator.token)).json());

    for (let index = 1; index < TRIP_LIMITS.maxMembers; index += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/trips/join',
        headers: authHeaders(harness.identity(`member-${index}`)),
        payload: {
          token: created.invite.token,
          display_name: `Member ${index}`,
          budget_cents: 10_000,
        },
      });
      expect(response.statusCode).toBe(200);
    }

    const overflow = await harness.app.inject({
      method: 'POST',
      url: '/api/trips/join',
      headers: authHeaders(harness.identity('overflow')),
      payload: { token: created.invite.token, display_name: 'Too many', budget_cents: 0 },
    });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json<{ error: { code: string } }>().error.code).toBe('TRIP_FULL');

    const preview = await harness.app.inject({
      method: 'POST',
      url: '/api/invites/preview',
      headers: authHeaders(harness.identity('peeker')),
      payload: { token: created.invite.token },
    });
    expect(invitePreviewResponse.parse(preview.json()).unavailable_reason).toBe('trip_full');
  });

  it('rejects a capacity overflow without losing the existing roster', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator.token)).json());
    for (let index = 1; index < TRIP_LIMITS.maxMembers; index += 1) {
      await harness.app.inject({
        method: 'POST',
        url: '/api/trips/join',
        headers: authHeaders(harness.identity(`member-${index}`)),
        payload: { token: created.invite.token, display_name: `M${index}`, budget_cents: 0 },
      });
    }
    await harness.app.inject({
      method: 'POST',
      url: '/api/trips/join',
      headers: authHeaders(harness.identity('overflow')),
      payload: { token: created.invite.token, display_name: 'Too many', budget_cents: 0 },
    });

    const count = await harness.pool.query<{ count: string }>(
      'select count(*) as count from person where trip_id = $1',
      [created.trip.id],
    );
    expect(Number(count.rows[0]?.count)).toBe(TRIP_LIMITS.maxMembers);
  });
});

describe('trip isolation', () => {
  it('hides a trip from a nonmember', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator.token)).json());

    const outsider = harness.identity('outsider');
    const snapshot = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${created.trip.id}/snapshot`,
      headers: authHeaders(outsider),
    });
    expect(snapshot.statusCode).toBe(404);

    const messages = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${created.trip.id}/messages`,
      headers: authHeaders(outsider),
    });
    expect(messages.statusCode).toBe(404);

    const send = await harness.app.inject({
      method: 'POST',
      url: `/api/trips/${created.trip.id}/messages`,
      headers: authHeaders(outsider),
      payload: { body: 'let me in', client_nonce: randomUUID() },
    });
    expect(send.statusCode).toBe(404);
  });

  it('does not let a member of one trip act on another', async () => {
    const alice = harness.identity('alice');
    const bob = harness.identity('bob');
    const tripA = createTripResponse.parse((await createTrip(alice.token)).json());
    const tripB = createTripResponse.parse((await createTrip(bob.token)).json());

    const crossRead = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${tripB.trip.id}/snapshot`,
      headers: authHeaders(alice),
    });
    expect(crossRead.statusCode).toBe(404);

    const crossEdit = await harness.app.inject({
      method: 'PATCH',
      url: `/api/trips/${tripB.trip.id}/people/me`,
      headers: authHeaders(alice),
      payload: {
        idempotency_key: randomUUID(),
        expected_calendar_version: tripB.calendar_version,
        budget_cents: 1,
      },
    });
    expect(crossEdit.statusCode).toBe(404);

    // Trip A is untouched.
    const snapshot = snapshotResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/api/trips/${tripA.trip.id}/snapshot`,
          headers: authHeaders(alice),
        })
      ).json(),
    );
    expect(snapshot.members).toHaveLength(1);
  });

  it('returns 404 rather than 403 for a trip the caller cannot see', async () => {
    const outsider = harness.identity('outsider');
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${randomUUID()}/snapshot`,
      headers: authHeaders(outsider),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('invite rotation', () => {
  it('lets any member mint a link but only the creator revoke existing ones', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator.token)).json());

    const joiner = harness.identity('joiner');
    await harness.app.inject({
      method: 'POST',
      url: '/api/trips/join',
      headers: authHeaders(joiner),
      payload: { token: created.invite.token, display_name: 'Grace', budget_cents: 0 },
    });

    const minted = await harness.app.inject({
      method: 'POST',
      url: `/api/trips/${created.trip.id}/invites`,
      headers: authHeaders(joiner),
      payload: { idempotency_key: randomUUID(), rotate: false },
    });
    expect(minted.statusCode).toBe(201);

    const forbidden = await harness.app.inject({
      method: 'POST',
      url: `/api/trips/${created.trip.id}/invites`,
      headers: authHeaders(joiner),
      payload: { idempotency_key: randomUUID(), rotate: true },
    });
    expect(forbidden.statusCode).toBe(403);

    const rotated = await harness.app.inject({
      method: 'POST',
      url: `/api/trips/${created.trip.id}/invites`,
      headers: authHeaders(creator),
      payload: { idempotency_key: randomUUID(), rotate: true },
    });
    expect(rotated.statusCode).toBe(201);

    // Rotation revokes old links without ejecting anyone who already joined.
    const stalePreview = await harness.app.inject({
      method: 'POST',
      url: '/api/invites/preview',
      headers: authHeaders(harness.identity('late')),
      payload: { token: created.invite.token },
    });
    expect(invitePreviewResponse.parse(stalePreview.json()).unavailable_reason).toBe('revoked');

    const snapshot = snapshotResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/api/trips/${created.trip.id}/snapshot`,
          headers: authHeaders(joiner),
        })
      ).json(),
    );
    expect(snapshot.members).toHaveLength(2);
  });
});

describe('immutable trip properties', () => {
  it('refuses to edit dates, destination or currency', async () => {
    const creator = harness.identity('creator');
    const created = createTripResponse.parse((await createTrip(creator.token)).json());

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/trips/${created.trip.id}`,
      headers: authHeaders(creator),
      payload: {
        idempotency_key: randomUUID(),
        expected_calendar_version: created.calendar_version,
        start_date: '2026-11-01',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});
