import { describe, expect, it } from 'vitest';
import { snapshotResponse, type SnapshotResponse, type WarningResource } from '@trip/contracts';
import { createDemoAdapter } from '../../apps/web/src/adapter/demo/adapter';
import { DEMO_TRIP_ID, PERSON, PLACE } from '../../apps/web/src/adapter/demo/dataset';
import { matchScenario, SCENARIOS } from '../../apps/web/src/adapter/demo/scenarios';
import type { PlannerAdapter } from '../../apps/web/src/adapter/types';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

/** The simulated pipeline runs on a timer; zero keeps the tests deterministic. */
function adapter(): PlannerAdapter {
  return createDemoAdapter(memoryStorage(), { processingMs: 0 });
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One "Update plan" press, start to finish. */
async function updatePlan(target: PlannerAdapter, scenarioId?: string): Promise<SnapshotResponse> {
  if (scenarioId === undefined) {
    await target.requestProcessing(DEMO_TRIP_ID, { idempotency_key: 'demo-update-key-1' });
  } else {
    target.demo?.runScenario(scenarioId);
  }
  await settled();
  const snapshot = await target.snapshot(DEMO_TRIP_ID);
  return snapshotResponse.parse(snapshot);
}

function warningsOfKind(snapshot: SnapshotResponse, kind: WarningResource['kind']) {
  return snapshot.warnings.filter((warning) => warning.kind === kind);
}

describe('demo fixtures', () => {
  it('seeds a contract-valid three-day Pittsburgh trip for four people', async () => {
    const snapshot = await adapter().snapshot(DEMO_TRIP_ID);
    snapshotResponse.parse(snapshot);

    expect(snapshot.trip.dates).toEqual(['2026-10-09', '2026-10-10', '2026-10-11']);
    expect(snapshot.trip.timezone).toBe('America/New_York');
    expect(snapshot.members.map((person) => person.display_name)).toEqual([
      'Ana',
      'Ben',
      'Cleo',
      'Dev',
    ]);

    // Distinct budgets and distinct, stable colours.
    const budgets = snapshot.members.map((person) => person.budget_cents);
    expect(new Set(budgets).size).toBe(4);
    expect(new Set(snapshot.members.map((person) => person.color)).size).toBe(4);
  });

  it('stores venue coordinates but leaves unverified hours unknown', async () => {
    const snapshot = await adapter().snapshot(DEMO_TRIP_ID);
    expect(snapshot.places).toHaveLength(4);
    for (const place of snapshot.places) {
      expect(place.coordinate).not.toBeNull();
      expect(place.resolution).toBe('manual');
      // No schedule was verified for these dates, so none is claimed.
      expect(place.hours_days).toEqual([]);
      expect(place.hours_provenance).toBeNull();
    }
    // An event at a venue with no schedule reads as unknown hours, not open.
    expect(snapshot.unknown_coverage.unknown_hours_event_ids.length).toBeGreaterThan(0);
    expect(snapshot.unknown_coverage.unresolved_place_event_ids).toEqual([]);
  });
});

describe('deterministic scenarios', () => {
  it('matches on keywords only, in order, and never twice', () => {
    const first = matchScenario('the carnegie museum sounds good', []);
    expect(first?.id).toBe('museum-agreement');
    expect(matchScenario('the carnegie museum sounds good', ['museum-agreement'])).toBeNull();
    expect(matchScenario('something entirely unrelated', [])).toBeNull();
  });

  it('creates the museum visit for exactly the two people who asked', async () => {
    const target = adapter();
    const snapshot = await updatePlan(target);

    const museum = snapshot.events.find((event) => event.place_id === PLACE.museum);
    expect(museum).toBeDefined();
    expect(museum?.created_by).toBe('llm');
    // A scripted outcome does not pin the schedule; only a human edit does.
    expect(museum?.schedule_locked_by_human).toBe(false);
    expect(museum?.price_source).toBe('estimate');

    const roster = snapshot.attendance
      .filter((row) => row.event_id === museum?.id)
      .map((row) => row.person_id);
    expect(roster.sort()).toEqual([PERSON.ana, PERSON.ben].sort());
  });

  it('says what it did, and labels the outcome as simulated', async () => {
    const target = adapter();
    await updatePlan(target);
    const page = await target.messages(DEMO_TRIP_ID);
    const bot = page.messages.filter((row) => row.kind === 'bot');
    expect(bot).toHaveLength(1);
    expect(bot[0]?.metadata).toMatchObject({ simulated: true, scenario_id: 'museum-agreement' });
    expect(bot[0]?.batch_id).not.toBeNull();
  });

  it('splits the group when the second pair picks a simultaneous alternative', async () => {
    const target = adapter();
    await updatePlan(target);
    const snapshot = await updatePlan(target);

    const saturday = snapshot.day_paths.find((day) => day.date === '2026-10-10');
    // Two separate roots on the same morning: the calendar and map both branch.
    expect(saturday?.nodes.filter((node) => node.depth === 0)).toHaveLength(2);
    expect(saturday?.idle_member_ids).toEqual([]);
    for (const node of saturday?.nodes ?? []) {
      expect(node.unresolved).toBe(false);
    }
  });

  it('reports a double booking when one person joins both', async () => {
    const target = adapter();
    await updatePlan(target);
    await updatePlan(target);
    const snapshot = await updatePlan(target, 'double-booking');

    const clashes = warningsOfKind(snapshot, 'double_booking');
    expect(clashes).toHaveLength(1);
    expect(clashes[0]?.person_id).toBe(PERSON.dev);
    expect(clashes[0]?.details).toMatchObject({ overlap_minutes: 90 });

    // The same overlap must not also be reported as a travel problem.
    expect(warningsOfKind(snapshot, 'insufficient_travel_time')).toEqual([]);
  });

  it('reports overspend against the smallest budget', async () => {
    const target = adapter();
    await updatePlan(target);
    const snapshot = await updatePlan(target, 'dinner-overspend');

    const ben = snapshot.budgets.find((row) => row.person_id === PERSON.ben);
    expect(ben?.status).toBe('over');
    // Museum 25.00 + dinner 180.00, against a 120.00 budget.
    expect(ben?.known_spend_cents).toBe(20_500);
    expect(ben?.estimate_subtotal_cents).toBe(20_500);

    const overspend = warningsOfKind(snapshot, 'budget_exceeded');
    expect(overspend.map((warning) => warning.person_id)).toContain(PERSON.ben);

    // The dinner has no venue, so it is an unresolved stop, not a fake one.
    const dinner = snapshot.events.find((event) => event.label === 'Group dinner');
    expect(dinner?.place_id).toBeNull();
  });

  it('reports insufficient travel time between two known locations', async () => {
    const target = adapter();
    await updatePlan(target);
    await updatePlan(target);
    const snapshot = await updatePlan(target, 'afternoon-walk');

    const travel = warningsOfKind(snapshot, 'insufficient_travel_time');
    expect(travel.length).toBeGreaterThan(0);
    const ana = travel.find((warning) => warning.person_id === PERSON.ana);
    expect(ana?.details).toMatchObject({ available_minutes: 10 });
    if (ana?.kind === 'insufficient_travel_time') {
      expect(ana.details.required_minutes ?? 0).toBeGreaterThan(10);
      expect(ana.details.distance_km ?? 0).toBeGreaterThan(4);
    }
  });

  it('turns a recorded closure into a venue warning, and leaves other days unknown', async () => {
    const target = adapter();
    const before = await target.snapshot(DEMO_TRIP_ID);
    expect(warningsOfKind(snapshotResponse.parse(before), 'venue_closed')).toEqual([]);

    const snapshot = await updatePlan(target, 'phipps-closed');
    const closed = warningsOfKind(snapshot, 'venue_closed');
    expect(closed).toHaveLength(1);
    if (closed[0]?.kind === 'venue_closed') {
      expect(closed[0].details.place_id).toBe(PLACE.phipps);
      // Recorded by a person, so it is labelled as a human correction.
      expect(closed[0].details.provenance).toBe('human');
    }

    const phipps = snapshot.places.find((place) => place.id === PLACE.phipps);
    expect(phipps?.human_override).toBe(true);
    expect(phipps?.hours_days).toHaveLength(1);
  });

  it('fails an extraction honestly, then succeeds on retry', async () => {
    const target = adapter();
    target.demo?.runScenario('provider-failure');
    await settled();

    const failed = await target.processing(DEMO_TRIP_ID);
    expect(failed.processing.state).toBe('failed');
    expect(failed.processing.last_error_code).toBe('provider_unavailable');
    expect(failed.processing.attempts).toBe(1);

    // Nothing was written by the failed attempt.
    const afterFailure = await target.snapshot(DEMO_TRIP_ID);
    expect(afterFailure.events).toHaveLength(2);

    target.demo?.runScenario('provider-failure');
    await settled();
    const retried = await target.processing(DEMO_TRIP_ID);
    expect(retried.processing.state).toBe('idle');
    expect(retried.processing.last_error_code).toBeNull();
  });

  it('says nothing applies rather than inventing a plan', async () => {
    const target = adapter();
    // Play out everything the seeded transcript evidences.
    await updatePlan(target);
    await updatePlan(target);

    await target.sendMessage(DEMO_TRIP_ID, {
      body: 'What about a hot air balloon over the rivers?',
      client_nonce: '44444444-4444-4444-8444-444444444444',
    });
    await updatePlan(target);

    const page = await target.messages(DEMO_TRIP_ID);
    const last = page.messages[page.messages.length - 1];
    expect(last?.kind).toBe('bot');
    expect(last?.metadata).toMatchObject({ unmatched: true, scenario_id: null });
    expect(last?.body).toContain('No scripted demo scenario matches');
  });

  it('lists its scenarios and marks the ones already played', async () => {
    const target = adapter();
    expect(target.demo?.scenarios()).toHaveLength(SCENARIOS.length);
    await updatePlan(target);
    const applied = target.demo?.scenarios().filter((scenario) => scenario.applied);
    expect(applied?.map((scenario) => scenario.id)).toEqual(['museum-agreement']);
  });
});

describe('demo state coherence', () => {
  it('keeps calendar, budget, warnings and paths agreeing after a manual edit', async () => {
    const target = adapter();
    await updatePlan(target);
    await updatePlan(target);
    let snapshot = await updatePlan(target, 'afternoon-walk');

    expect(warningsOfKind(snapshot, 'insufficient_travel_time').length).toBeGreaterThan(0);

    // Move the regroup later; the travel warning must clear everywhere at once.
    const walk = snapshot.events.find((event) => event.label === 'Regroup at the Point');
    await target.patchEvent(DEMO_TRIP_ID, walk?.id ?? '', {
      idempotency_key: 'demo-move-key-01',
      expected_calendar_version: snapshot.calendar_version,
      start_minute: 900,
      end_minute: 1000,
    });
    snapshot = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));

    expect(warningsOfKind(snapshot, 'insufficient_travel_time')).toEqual([]);
    const moved = snapshot.events.find((event) => event.id === walk?.id);
    expect(moved?.start_minute).toBe(900);
    // A human time edit pins the schedule.
    expect(moved?.schedule_locked_by_human).toBe(true);
    expect(moved?.starts_at).toBe('2026-10-10T15:00:00-04:00');
  });

  it('recomputes every dependent view when attendance changes', async () => {
    const target = adapter();
    await updatePlan(target);
    let snapshot = await updatePlan(target, 'dinner-overspend');
    expect(snapshot.budgets.find((row) => row.person_id === PERSON.ben)?.status).toBe('over');

    // Ben backs out of the dinner as himself.
    target.demo?.switchParticipant(PERSON.ben);
    const dinner = snapshot.events.find((event) => event.label === 'Group dinner');
    await target.setSelfAttendance(DEMO_TRIP_ID, dinner?.id ?? '', {
      idempotency_key: 'demo-out-key-001',
      expected_calendar_version: snapshot.calendar_version,
      state: 'out',
    });
    snapshot = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));

    const ben = snapshot.budgets.find((row) => row.person_id === PERSON.ben);
    expect(ben?.known_spend_cents).toBe(2500);
    expect(ben?.status).toBe('within');
    expect(warningsOfKind(snapshot, 'budget_exceeded').map((w) => w.person_id)).not.toContain(
      PERSON.ben,
    );
    // The dinner survives: three other people are still attending.
    expect(snapshot.events.some((event) => event.id === dinner?.id)).toBe(true);
  });

  it('survives a reload and returns to the seed on reset', async () => {
    const storage = memoryStorage();
    const first = createDemoAdapter(storage, { processingMs: 0 });
    first.demo?.runScenario('museum-agreement');
    await settled();

    const reloaded = createDemoAdapter(storage, { processingMs: 0 });
    const restored = await reloaded.snapshot(DEMO_TRIP_ID);
    expect(restored.events.some((event) => event.place_id === PLACE.museum)).toBe(true);
    expect(reloaded.demo?.scenarios().some((scenario) => scenario.applied)).toBe(true);

    reloaded.demo?.reset();
    const seeded = await reloaded.snapshot(DEMO_TRIP_ID);
    expect(seeded.events.some((event) => event.place_id === PLACE.museum)).toBe(false);
    expect(seeded.events).toHaveLength(2);
    expect(reloaded.demo?.scenarios().every((scenario) => !scenario.applied)).toBe(true);
  });
});
