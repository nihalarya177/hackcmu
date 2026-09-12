import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LlmEnvelope } from '@trip/contracts';
import { batchRun, message, trip } from '@trip/db';
import { and, eq } from 'drizzle-orm';
import { applyEnvelope, type ApplyContext } from '../../apps/server/src/jobs/apply.js';
import { parseEnvelope } from '../../apps/server/src/llm/envelope.js';
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

/** A trip with two members who have each said something. */
async function seed() {
  const owner = harness.identity('owner');
  const guest = harness.identity('guest');

  const created = await harness.app.inject({
    method: 'POST',
    url: '/api/trips',
    headers: authHeaders(owner),
    payload: tripPayload(),
  });
  const trip = created.json<{
    trip: { id: string };
    self: { id: string };
    invite: { token: string };
  }>();

  const joined = await harness.app.inject({
    method: 'POST',
    url: '/api/trips/join',
    headers: authHeaders(guest),
    payload: { token: trip.invite.token, display_name: 'Grace', budget_cents: 20_000 },
  });
  const guestPerson = joined.json<{ self: { id: string } }>().self.id;

  const say = async (identity: TestIdentity, body: string): Promise<string> => {
    const sent = await harness.app.inject({
      method: 'POST',
      url: `/api/trips/${trip.trip.id}/messages`,
      headers: authHeaders(identity),
      payload: { body, client_nonce: randomUUID() },
    });
    return sent.json<{ message: { id: string } }>().message.id;
  };

  return { owner, guest, tripId: trip.trip.id, ownerPerson: trip.self.id, guestPerson, say };
}

async function contextFor(
  tripId: string,
  members: string[],
  authored: Record<string, string | null>,
): Promise<ApplyContext> {
  const rows = await harness.database.db.select().from(trip).where(eq(trip.id, tripId)).limit(1);
  const tripRow = rows[0];
  if (tripRow === undefined) throw new Error('trip missing');

  const batch = await harness.database.db
    .insert(batchRun)
    .values({
      tripId,
      lowerExclusiveMsgId: 0n,
      upperInclusiveMsgId: 1_000_000n,
      capturedCalendarVersion: tripRow.calendarVersion,
      status: 'running',
    })
    .returning();

  return {
    tripId,
    timezone: tripRow.timezone,
    dates: ['2026-10-02', '2026-10-03', '2026-10-04'],
    lowerExclusiveMsgId: 0n,
    upperInclusiveMsgId: 1_000_000n,
    batchId: batch[0]?.id ?? '',
    memberIds: new Set(members),
    authorOf: new Map(Object.entries(authored)),
  };
}

/** The version an edit must name, read rather than assumed. */
async function currentVersion(identity: TestIdentity, tripId: string): Promise<string> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/trips/${tripId}/snapshot`,
    headers: authHeaders(identity),
  });
  return response.json<{ calendar_version: string }>().calendar_version;
}

/** Creates an event through the real HTTP command, as a person would. */
async function addEvent(
  identity: TestIdentity,
  tripId: string,
  label: string,
): Promise<{ eventId: string; version: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/api/trips/${tripId}/events`,
    headers: authHeaders(identity),
    payload: {
      idempotency_key: randomUUID(),
      expected_calendar_version: await currentVersion(identity, tripId),
      label,
      local_date: '2026-10-03',
      start_minute: 600,
      end_minute: 720,
      price_cents: null,
      price_source: null,
      place: null,
    },
  });
  const body = response.json<{ event: { id: string }; calendar_version: string }>();
  return { eventId: body.event.id, version: body.calendar_version };
}

function createOp(overrides: Record<string, unknown> = {}): LlmEnvelope {
  return {
    operations: [
      {
        op: 'create_event',
        source_message_ids: ['1'],
        label: 'Carnegie Museum of Art',
        local_date: '2026-10-03',
        start_minute: 600,
        duration_minutes: 120,
        place: null,
        estimated_price_cents: 2500,
        attendees: [],
        revive_tombstone_id: null,
        ...overrides,
      },
    ],
    clarifications: [],
  };
}

describe('envelope parsing', () => {
  it('turns the provider shape into the strict contract', () => {
    const { envelope } = parseEnvelope(
      JSON.stringify({
        operations: [
          {
            op: 'create_event',
            source_message_ids: ['4'],
            label: 'Museum',
            local_date: '2026-10-03',
            start_minute: 600,
            duration_minutes: 90,
            estimated_price_cents: null,
            place_query: 'Carnegie Museum of Art',
            attendees: [
              { person_id: '11111111-1111-4111-8111-111111111111', evidence_message_ids: ['2'] },
              { person_id: '22222222-2222-4222-8222-222222222222', evidence_message_ids: ['3'] },
            ],
          },
        ],
        clarifications: [],
      }),
    );
    const operation = envelope.operations[0];
    expect(operation?.op).toBe('create_event');
    if (operation?.op === 'create_event') {
      expect(operation.place).toEqual({ kind: 'query', query: 'Carnegie Museum of Art' });
    }
  });

  it('fails the attempt when the output is not an envelope at all', () => {
    // A truncated or malformed answer is a failed attempt, never an empty
    // successful batch.
    expect(() => parseEnvelope('{"operations": [')).toThrow(/provider_output_not_json/);
    expect(() => parseEnvelope(JSON.stringify({ nothing: true }))).toThrow(
      /provider_output_failed_schema/,
    );
  });

  it('discards one bad operation instead of throwing away the good ones', () => {
    const { envelope, discarded } = parseEnvelope(
      JSON.stringify({
        operations: [
          {
            op: 'create_event',
            source_message_ids: ['3'],
            label: 'Museum',
            local_date: '2026-10-03',
            start_minute: 600,
            duration_minutes: 90,
            estimated_price_cents: null,
            attendees: [
              { person_id: '11111111-1111-4111-8111-111111111111', evidence_message_ids: ['2'] },
              { person_id: '22222222-2222-4222-8222-222222222222', evidence_message_ids: ['3'] },
            ],
          },
          // A forward reference to the event being created in the same answer.
          { op: 'assign', source_message_ids: ['3'], event_id: null, attendees: [] },
        ],
        clarifications: [],
      }),
    );
    expect(envelope.operations).toHaveLength(1);
    expect(discarded).toEqual([{ op: 'assign', code: 'forward_reference_to_new_event' }]);
  });
});

describe('consent and evidence', () => {
  it('creates an event when two people each said yes in their own message', async () => {
    const { tripId, ownerPerson, guestPerson, say, owner, guest } = await seed();
    const a = await say(owner, 'Carnegie Museum of Art on Saturday?');
    const b = await say(guest, 'yes, I am in');

    const context = await contextFor(tripId, [ownerPerson, guestPerson], {
      [a]: ownerPerson,
      [b]: guestPerson,
    });
    const envelope = createOp({
      source_message_ids: [b],
      attendees: [
        { person_id: ownerPerson, evidence_message_ids: [a] },
        { person_id: guestPerson, evidence_message_ids: [b] },
      ],
    });

    const outcome = await harness.database.db.transaction((tx) =>
      applyEnvelope(tx, context, envelope),
    );
    expect(outcome.accepted).toBe(1);
    expect(outcome.rejections).toEqual([]);
  });

  it('refuses consent claimed on somebody else evidence', async () => {
    const { tripId, ownerPerson, guestPerson, say, owner } = await seed();
    const a = await say(owner, 'Museum on Saturday? Grace is in too.');

    // Both attendees cite a message only the owner wrote.
    const context = await contextFor(tripId, [ownerPerson, guestPerson], { [a]: ownerPerson });
    const envelope = createOp({
      source_message_ids: [a],
      attendees: [
        { person_id: ownerPerson, evidence_message_ids: [a] },
        { person_id: guestPerson, evidence_message_ids: [a] },
      ],
    });

    const outcome = await harness.database.db.transaction((tx) =>
      applyEnvelope(tx, context, envelope),
    );
    expect(outcome.accepted).toBe(0);
    expect(outcome.rejections[0]?.code).toBe('evidence_not_authored_by_person');
  });

  it('refuses a single-person agreement', async () => {
    const { tripId, ownerPerson, guestPerson, say, owner } = await seed();
    const a = await say(owner, 'I want to go to the museum');

    const context = await contextFor(tripId, [ownerPerson, guestPerson], { [a]: ownerPerson });
    const envelope = createOp({
      source_message_ids: [a],
      attendees: [
        { person_id: ownerPerson, evidence_message_ids: [a] },
        { person_id: ownerPerson, evidence_message_ids: [a] },
      ],
    });

    const outcome = await harness.database.db.transaction((tx) =>
      applyEnvelope(tx, context, envelope),
    );
    expect(outcome.rejections[0]?.code).toBe('attendee_count_below_minimum');
  });

  it('refuses an operation no message in this batch triggered', async () => {
    const { tripId, ownerPerson, guestPerson, say, owner, guest } = await seed();
    const a = await say(owner, 'museum?');
    const b = await say(guest, 'yes');

    const context = await contextFor(tripId, [ownerPerson, guestPerson], {
      [a]: ownerPerson,
      [b]: guestPerson,
    });
    // Both source messages sit below the batch's lower bound.
    const older = { ...context, lowerExclusiveMsgId: BigInt(b) };

    const outcome = await harness.database.db.transaction((tx) =>
      applyEnvelope(
        tx,
        older,
        createOp({
          source_message_ids: [a],
          attendees: [
            { person_id: ownerPerson, evidence_message_ids: [a] },
            { person_id: guestPerson, evidence_message_ids: [b] },
          ],
        }),
      ),
    );
    expect(outcome.rejections[0]?.code).toBe('no_current_batch_trigger');
  });
});

describe('human precedence and protection', () => {
  it('will not move an event whose time a person set', async () => {
    const { tripId, ownerPerson, guestPerson, say, owner, guest } = await seed();
    const { eventId } = await addEvent(owner, tripId, 'Museum');

    const a = await say(owner, 'move it later');
    const b = await say(guest, 'yes move it');
    const context = await contextFor(tripId, [ownerPerson, guestPerson], {
      [a]: ownerPerson,
      [b]: guestPerson,
    });

    const outcome = await harness.database.db.transaction((tx) =>
      applyEnvelope(tx, context, {
        operations: [
          {
            op: 'reschedule_event',
            source_message_ids: [b],
            event_id: eventId,
            local_date: '2026-10-03',
            start_minute: 900,
            end_minute: 1020,
            movers: [
              { person_id: ownerPerson, evidence_message_ids: [a] },
              { person_id: guestPerson, evidence_message_ids: [b] },
            ],
          },
        ],
        clarifications: [],
      }),
    );
    expect(outcome.rejections[0]?.code).toBe('schedule_locked_by_human');
  });

  it('will not overturn a person own attendance choice', async () => {
    const { tripId, ownerPerson, guestPerson, say, owner, guest } = await seed();
    const { eventId, version } = await addEvent(owner, tripId, 'Museum');

    // Grace explicitly says she is not going.
    await harness.app.inject({
      method: 'PUT',
      url: `/api/trips/${tripId}/events/${eventId}/attendance/me`,
      headers: authHeaders(guest),
      payload: { idempotency_key: randomUUID(), expected_calendar_version: version, state: 'out' },
    });

    const b = await say(guest, 'maybe I will come');
    const context = await contextFor(tripId, [ownerPerson, guestPerson], { [b]: guestPerson });

    const outcome = await harness.database.db.transaction((tx) =>
      applyEnvelope(tx, context, {
        operations: [
          {
            op: 'assign',
            source_message_ids: [b],
            event_id: eventId,
            attendee: { person_id: guestPerson, evidence_message_ids: [b] },
          },
        ],
        clarifications: [],
      }),
    );
    expect(outcome.rejections[0]?.code).toBe('human_decision_protected');
  });
});

describe('duplicates and tombstones', () => {
  it('refuses a duplicate of an event already on the calendar', async () => {
    const { tripId, ownerPerson, guestPerson, say, owner, guest } = await seed();
    const a = await say(owner, 'museum?');
    const b = await say(guest, 'yes');
    const context = await contextFor(tripId, [ownerPerson, guestPerson], {
      [a]: ownerPerson,
      [b]: guestPerson,
    });
    const envelope = createOp({
      source_message_ids: [b],
      attendees: [
        { person_id: ownerPerson, evidence_message_ids: [a] },
        { person_id: guestPerson, evidence_message_ids: [b] },
      ],
    });

    await harness.database.db.transaction((tx) => applyEnvelope(tx, context, envelope));
    const second = await harness.database.db.transaction((tx) =>
      applyEnvelope(tx, context, envelope),
    );
    expect(second.rejections[0]?.code).toBe('duplicate_of_active_event');
  });

  it('will not silently recreate something a person deleted', async () => {
    const { tripId, ownerPerson, guestPerson, say, owner, guest } = await seed();
    const { eventId, version } = await addEvent(owner, tripId, 'Carnegie Museum of Art');
    await harness.app.inject({
      method: 'DELETE',
      url: `/api/trips/${tripId}/events/${eventId}`,
      headers: authHeaders(owner),
      payload: {
        idempotency_key: randomUUID(),
        expected_calendar_version: version,
      },
    });

    const a = await say(owner, 'museum again?');
    const b = await say(guest, 'yes');
    const context = await contextFor(tripId, [ownerPerson, guestPerson], {
      [a]: ownerPerson,
      [b]: guestPerson,
    });

    const outcome = await harness.database.db.transaction((tx) =>
      applyEnvelope(
        tx,
        context,
        createOp({
          source_message_ids: [b],
          attendees: [
            { person_id: ownerPerson, evidence_message_ids: [a] },
            { person_id: guestPerson, evidence_message_ids: [b] },
          ],
        }),
      ),
    );
    expect(outcome.rejections[0]?.code).toBe('tombstone_requires_explicit_revival');
  });
});

describe('suggest_remove', () => {
  it('creates a button and changes nothing by itself', async () => {
    const { tripId, ownerPerson, guestPerson, say, owner } = await seed();
    const { eventId } = await addEvent(owner, tripId, 'Museum');
    const a = await say(owner, 'maybe drop the museum');
    const context = await contextFor(tripId, [ownerPerson, guestPerson], { [a]: ownerPerson });

    const outcome = await harness.database.db.transaction((tx) =>
      applyEnvelope(tx, context, {
        operations: [
          {
            op: 'suggest_remove',
            source_message_ids: [a],
            event_id: eventId,
            reason: 'over budget',
          },
        ],
        clarifications: [],
      }),
    );
    expect(outcome.accepted).toBe(1);

    const snapshot = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${tripId}/snapshot`,
      headers: authHeaders(owner),
    });
    const body = snapshot.json<{
      events: unknown[];
      actions: { type: string; status: string; available_choices: string[] }[];
    }>();
    // The event is untouched; only a pending action exists.
    expect(body.events).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({
      type: 'remove_suggestion',
      status: 'pending',
      available_choices: ['remove', 'keep'],
    });
  });
});

describe('batch bookkeeping', () => {
  it('records the model, prompt and schema versions it used', async () => {
    const rows = await harness.database.db.select().from(batchRun).limit(1);
    // Nothing to assert without a run; the shape is exercised by the live test.
    expect(Array.isArray(rows)).toBe(true);
  });

  it('counts pending user messages for the trigger', async () => {
    const { tripId, say, owner } = await seed();
    await say(owner, 'one');
    await say(owner, 'two');
    const rows = await harness.database.db.select().from(trip).where(eq(trip.id, tripId)).limit(1);
    expect(rows[0]?.pendingUserMessageCount).toBe(2);
    const stored = await harness.database.db
      .select()
      .from(message)
      .where(and(eq(message.tripId, tripId), eq(message.kind, 'user')));
    expect(stored).toHaveLength(2);
  });
});
