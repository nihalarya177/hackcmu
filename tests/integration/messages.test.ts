import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMessageResponse,
  createTripResponse,
  listMessagesResponse,
  RATE_LIMITS,
  snapshotResponse,
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

async function newTrip(identity: TestIdentity) {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/trips',
    headers: authHeaders(identity),
    payload: tripPayload(),
  });
  return createTripResponse.parse(response.json());
}

async function send(identity: TestIdentity, tripId: string, body: string, nonce = randomUUID()) {
  return harness.app.inject({
    method: 'POST',
    url: `/api/trips/${tripId}/messages`,
    headers: authHeaders(identity),
    payload: { body, client_nonce: nonce },
  });
}

describe('chat', () => {
  it('appends a user message with an ascending id', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);

    const first = createMessageResponse.parse((await send(creator, trip.trip.id, 'one')).json());
    const second = createMessageResponse.parse((await send(creator, trip.trip.id, 'two')).json());

    expect(first.deduplicated).toBe(false);
    expect(BigInt(second.message.id)).toBeGreaterThan(BigInt(first.message.id));
    expect(second.message.kind).toBe('user');
    expect(second.message.author_person_id).toBe(trip.self.id);
  });

  it('does not change the calendar version', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);
    await send(creator, trip.trip.id, 'chatting');

    const snapshot = snapshotResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/api/trips/${trip.trip.id}/snapshot`,
          headers: authHeaders(creator),
        })
      ).json(),
    );
    expect(snapshot.calendar_version).toBe(trip.calendar_version);
  });

  it('returns the original row when a send is retried with the same nonce', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);
    const nonce = randomUUID();

    const first = createMessageResponse.parse(
      (await send(creator, trip.trip.id, 'hello', nonce)).json(),
    );
    const retry = await send(creator, trip.trip.id, 'hello', nonce);

    expect(retry.statusCode).toBe(200);
    const replayed = createMessageResponse.parse(retry.json());
    expect(replayed.deduplicated).toBe(true);
    expect(replayed.message.id).toBe(first.message.id);

    const count = await harness.pool.query<{ count: string }>(
      "select count(*) as count from message where kind = 'user'",
    );
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it('stores one row when the same nonce is sent concurrently', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);
    const nonce = randomUUID();

    const responses = await Promise.all([
      send(creator, trip.trip.id, 'hello', nonce),
      send(creator, trip.trip.id, 'hello', nonce),
      send(creator, trip.trip.id, 'hello', nonce),
    ]);

    const ids = new Set(responses.map((r) => createMessageResponse.parse(r.json()).message.id));
    expect(ids.size).toBe(1);
  });

  it('records a system message when someone joins, without an author', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);
    const joiner = harness.identity('joiner');
    await harness.app.inject({
      method: 'POST',
      url: '/api/trips/join',
      headers: authHeaders(joiner),
      payload: { token: trip.invite.token, display_name: 'Grace', budget_cents: 0 },
    });

    const page = listMessagesResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/api/trips/${trip.trip.id}/messages`,
          headers: authHeaders(creator),
        })
      ).json(),
    );

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.kind).toBe('system');
    expect(page.messages[0]?.author_person_id).toBeNull();
  });

  it('rejects a reply to a message in another trip', async () => {
    const alice = harness.identity('alice');
    const bob = harness.identity('bob');
    const tripA = await newTrip(alice);
    const tripB = await newTrip(bob);

    const foreign = createMessageResponse.parse(
      (await send(bob, tripB.trip.id, 'over here')).json(),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/trips/${tripA.trip.id}/messages`,
      headers: authHeaders(alice),
      payload: {
        body: 'replying across trips',
        client_nonce: randomUUID(),
        reply_to_message_id: foreign.message.id,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('enforces the per-member send limit', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);

    for (let index = 0; index < RATE_LIMITS.messagesPerMinutePerMember; index += 1) {
      const response = await send(creator, trip.trip.id, `message ${index}`);
      expect(response.statusCode).toBe(201);
    }

    const blocked = await send(creator, trip.trip.id, 'one too many');
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json<{ error: { code: string; retry_after_seconds: number } }>();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});

describe('message pagination', () => {
  it('returns the newest page first and walks backwards with before_id', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);
    for (let index = 0; index < 8; index += 1) {
      await send(creator, trip.trip.id, `m${index}`);
    }

    const newest = listMessagesResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/api/trips/${trip.trip.id}/messages?limit=3`,
          headers: authHeaders(creator),
        })
      ).json(),
    );
    expect(newest.messages.map((m) => m.body)).toEqual(['m5', 'm6', 'm7']);
    expect(newest.has_more).toBe(true);

    const older = listMessagesResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/api/trips/${trip.trip.id}/messages?limit=3&before_id=${newest.oldest_id ?? '0'}`,
          headers: authHeaders(creator),
        })
      ).json(),
    );
    expect(older.messages.map((m) => m.body)).toEqual(['m2', 'm3', 'm4']);
  });

  it('catches up forwards with after_id after a realtime gap', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);
    const anchor = createMessageResponse.parse((await send(creator, trip.trip.id, 'seen')).json());
    await send(creator, trip.trip.id, 'missed one');
    await send(creator, trip.trip.id, 'missed two');

    const catchUp = listMessagesResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/api/trips/${trip.trip.id}/messages?after_id=${anchor.message.id}`,
          headers: authHeaders(creator),
        })
      ).json(),
    );

    expect(catchUp.messages.map((m) => m.body)).toEqual(['missed one', 'missed two']);
    expect(catchUp.has_more).toBe(false);
  });

  it('refuses both cursors at once', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${trip.trip.id}/messages?before_id=5&after_id=2`,
      headers: authHeaders(creator),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('message id allocation order', () => {
  it('allocates ids inside the trip lock, so commit order matches id order', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);
    const personId = trip.self.id;

    const slow = await harness.pool.connect();
    const fast = await harness.pool.connect();

    try {
      // Writer A takes the trip lock and allocates its id, then stalls.
      await slow.query('begin');
      await slow.query('select id from trip where id = $1 for update', [trip.trip.id]);
      const slowInsert = await slow.query<{ id: string }>(
        `insert into message (trip_id, author_person_id, kind, body, client_nonce)
         values ($1, $2, 'user', 'first writer', gen_random_uuid()) returning id`,
        [trip.trip.id, personId],
      );

      // Writer B asks for the same lock and must wait.
      await fast.query('begin');
      const blocked = fast.query('select id from trip where id = $1 for update', [trip.trip.id]);

      let released = false;
      const waiter = blocked.then(() => {
        released = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(released).toBe(false);

      await slow.query('commit');
      await waiter;

      const fastInsert = await fast.query<{ id: string }>(
        `insert into message (trip_id, author_person_id, kind, body, client_nonce)
         values ($1, $2, 'user', 'second writer', gen_random_uuid()) returning id`,
        [trip.trip.id, personId],
      );
      await fast.query('commit');

      // No committed message can fall behind one that committed before it.
      expect(BigInt(fastInsert.rows[0]?.id ?? '0')).toBeGreaterThan(
        BigInt(slowInsert.rows[0]?.id ?? '0'),
      );
    } finally {
      slow.release();
      fast.release();
    }

    const page = listMessagesResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/api/trips/${trip.trip.id}/messages`,
          headers: authHeaders(creator),
        })
      ).json(),
    );
    expect(page.messages.map((m) => m.body)).toEqual(['first writer', 'second writer']);
  });

  it('keeps concurrent sends distinct and ordered', async () => {
    const creator = harness.identity('creator');
    const trip = await newTrip(creator);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) => send(creator, trip.trip.id, `c${index}`)),
    );
    const ids = responses.map((r) => BigInt(createMessageResponse.parse(r.json()).message.id));

    expect(new Set(ids).size).toBe(10);

    const page = listMessagesResponse.parse(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/api/trips/${trip.trip.id}/messages?limit=100`,
          headers: authHeaders(creator),
        })
      ).json(),
    );
    const returned = page.messages.map((m) => BigInt(m.id));
    expect(returned).toEqual([...returned].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(returned).toHaveLength(10);
  });
});
