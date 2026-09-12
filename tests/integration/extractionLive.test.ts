import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { batchRun, trip } from '@trip/db';
import { tick, type SchedulerConfig } from '../../apps/server/src/jobs/scheduler.js';
import {
  authHeaders,
  createHarness,
  resetDatabase,
  tripPayload,
  type Harness,
  type TestIdentity,
} from '../support/harness.js';

/**
 * The live provider smoke test.
 *
 * Deliberately separate from the deterministic suite: it calls the real Gemini
 * API and costs a request, so CI runs the recorded-envelope tests instead. Run
 * with RUN_LLM=1 and GEMINI_API_KEY set.
 */
const enabled = process.env['RUN_LLM'] === '1' && (process.env['GEMINI_API_KEY'] ?? '') !== '';

let harness: Harness;

beforeAll(async () => {
  if (enabled) harness = await createHarness();
});
afterAll(async () => {
  if (enabled) await harness.close();
});
beforeEach(async () => {
  if (enabled) await resetDatabase(harness.pool);
});

describe.skipIf(!enabled)('genuine Gemini extraction', () => {
  const config = (): SchedulerConfig => ({
    workerId: 'test-worker',
    appRevision: 'test-revision',
    mode: 'demo',
    model: process.env['LLM_MODEL'] ?? 'gemini-3.5-flash-lite',
    apiKey: process.env['GEMINI_API_KEY'] ?? '',
    llmEnabled: true,
    dailyRequestLimit: 200,
  });

  async function twoPeopleAgree() {
    const owner = harness.identity('owner');
    const guest = harness.identity('guest');

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/trips',
      headers: authHeaders(owner),
      payload: tripPayload(),
    });
    const body = created.json<{ trip: { id: string }; invite: { token: string } }>();

    await harness.app.inject({
      method: 'POST',
      url: '/api/trips/join',
      headers: authHeaders(guest),
      payload: { token: body.invite.token, display_name: 'Grace', budget_cents: 20_000 },
    });

    const say = async (identity: TestIdentity, text: string): Promise<void> => {
      await harness.app.inject({
        method: 'POST',
        url: `/api/trips/${body.trip.id}/messages`,
        headers: authHeaders(identity),
        payload: { body: text, client_nonce: randomUUID() },
      });
    };

    return { tripId: body.trip.id, owner, guest, say };
  }

  it('turns a real two-person agreement into a real event', async () => {
    const { tripId, owner, guest, say } = await twoPeopleAgree();
    await say(owner, 'Shall we do the Carnegie Museum of Art on 3 October at 10am?');
    await say(guest, 'Yes, that works for me, I am in.');
    await say(owner, "Great, I'm going too.");

    await harness.app.inject({
      method: 'POST',
      url: `/api/trips/${tripId}/process`,
      headers: authHeaders(owner),
      payload: { idempotency_key: randomUUID() },
    });

    await tick(harness.database.db, config());

    const batches = await harness.database.db
      .select()
      .from(batchRun)
      .where(eq(batchRun.tripId, tripId));
    const batch = batches[0];
    expect(batch?.status).toBe('committed');
    // Every batch records exactly which model and prompt produced it.
    expect(batch?.model).toBe(config().model);
    expect(batch?.promptVersion).toBe('1');

    const snapshot = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${tripId}/snapshot`,
      headers: authHeaders(owner),
    });
    const state = snapshot.json<{
      events: { label: string; created_by: string; schedule_locked_by_human: boolean }[];
      attendance: unknown[];
      processing: { state: string };
    }>();

    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.created_by).toBe('llm');
    // An extracted event is not human-scheduled, so a later move is allowed.
    expect(state.events[0]?.schedule_locked_by_human).toBe(false);
    expect(state.events[0]?.label.toLowerCase()).toContain('carnegie');
    // Two people agreed, so two people are on it.
    expect(state.attendance).toHaveLength(2);
    expect(state.processing.state).toBe('unavailable');

    const after = await harness.database.db.select().from(trip).where(eq(trip.id, tripId)).limit(1);
    // The watermark advanced exactly to the batch's captured upper bound.
    expect(after[0]?.lastProcessedMsgId).toBe(batch?.upperInclusiveMsgId);
  }, 90_000);

  it("counts an inclusive proposal as the proposer's own consent", async () => {
    const { tripId, owner, guest, say } = await twoPeopleAgree();
    // Exactly the shape that silently produced nothing before: a proposal
    // phrased as "let's", one other person in, and one explicitly out.
    await say(owner, 'lets do the andy warhol museum on 3 October at 10 am');
    await say(guest, 'i am in');

    await harness.app.inject({
      method: 'POST',
      url: `/api/trips/${tripId}/process`,
      headers: authHeaders(owner),
      payload: { idempotency_key: randomUUID() },
    });
    await tick(harness.database.db, config());

    const snapshot = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${tripId}/snapshot`,
      headers: authHeaders(owner),
    });
    const state = snapshot.json<{
      events: {
        label: string;
        price_cents: number | null;
        price_source: string | null;
        start_minute: number;
        end_minute: number;
      }[];
      attendance: unknown[];
    }>();

    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.label.toLowerCase()).toContain('warhol');
    // The proposer plus the one person who agreed.
    expect(state.attendance).toHaveLength(2);
    // A price is estimated rather than left blank, and labelled as an estimate.
    expect(state.events[0]?.price_cents).not.toBeNull();
    expect(state.events[0]?.price_source).toBe('estimate');
    // A museum gets a realistic visit length, not a fixed default.
    const minutes = (state.events[0]?.end_minute ?? 0) - (state.events[0]?.start_minute ?? 0);
    expect(minutes).toBeGreaterThanOrEqual(90);
  }, 90_000);

  it('says something even when it changes nothing', async () => {
    const { tripId, owner, say } = await twoPeopleAgree();
    await say(owner, 'the weather looks alright for the weekend');

    await harness.app.inject({
      method: 'POST',
      url: `/api/trips/${tripId}/process`,
      headers: authHeaders(owner),
      payload: { idempotency_key: randomUUID() },
    });
    await tick(harness.database.db, config());

    const messages = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${tripId}/messages`,
      headers: authHeaders(owner),
    });
    const rows = messages.json<{ messages: { kind: string; body: string }[] }>().messages;
    // Silence is indistinguishable from being broken.
    expect(rows.filter((row) => row.kind === 'bot').length).toBeGreaterThan(0);
  }, 90_000);

  it('does not invent an event from one person talking to themselves', async () => {
    const { tripId, owner, say } = await twoPeopleAgree();
    await say(owner, 'I was thinking maybe the incline at some point, not sure.');
    await say(owner, 'Or possibly the museum. Undecided really.');

    await harness.app.inject({
      method: 'POST',
      url: `/api/trips/${tripId}/process`,
      headers: authHeaders(owner),
      payload: { idempotency_key: randomUUID() },
    });
    await tick(harness.database.db, config());

    const snapshot = await harness.app.inject({
      method: 'GET',
      url: `/api/trips/${tripId}/snapshot`,
      headers: authHeaders(owner),
    });
    // Nobody else agreed, so nothing is committed on their behalf.
    expect(snapshot.json<{ events: unknown[] }>().events).toHaveLength(0);
  }, 90_000);
});
