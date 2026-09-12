import { describe, expect, it } from 'vitest';
import {
  snapshotResponse,
  listMessagesResponse,
  createMessageResponse,
  eventMutationResponse,
  attendanceMutationResponse,
  type CreateEventRequest,
} from '@trip/contracts';
import { modeFromSearch, readStoredMode, resolveInitialMode } from '../../apps/web/src/mode';
import { createDemoAdapter } from '../../apps/web/src/adapter/demo/adapter';
import { DEMO_TRIP_ID } from '../../apps/web/src/adapter/demo/dataset';
import { createLiveAdapter } from '../../apps/web/src/adapter/live';
import { ApiRequestError, UnsupportedOperationError } from '../../apps/web/src/lib/apiError';

/** In-memory Storage, so demo persistence is exercised without a browser. */
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

const idem = 'demo-test-key-0001';

function eventRequest(overrides: Partial<CreateEventRequest> = {}): CreateEventRequest {
  return {
    idempotency_key: idem,
    expected_calendar_version: '1',
    label: 'Museum visit',
    local_date: '2026-10-09',
    start_minute: 600,
    end_minute: 720,
    price_cents: 2500,
    price_source: 'confirmed',
    place: null,
    ...overrides,
  };
}

describe('mode selection', () => {
  it('prefers an explicit mode in the URL over a remembered one', () => {
    const storage = memoryStorage();
    storage.setItem('trip-planner.mode', 'live');
    expect(resolveInitialMode({ search: '?mode=demo', storage })).toBe('demo');
  });

  it('falls back to the remembered mode, then to asking', () => {
    const storage = memoryStorage();
    expect(resolveInitialMode({ search: '', storage })).toBeNull();
    storage.setItem('trip-planner.mode', 'demo');
    expect(readStoredMode(storage)).toBe('demo');
    expect(resolveInitialMode({ search: '', storage })).toBe('demo');
  });

  it('ignores a mode it does not recognise rather than guessing', () => {
    expect(modeFromSearch('?mode=production')).toBeNull();
    expect(readStoredMode(memoryStorage())).toBeNull();
  });
});

describe('demo adapter', () => {
  it('starts with no credentials, no configuration and no network', async () => {
    const adapter = createDemoAdapter(null);
    await expect(adapter.start()).resolves.toBeUndefined();
  });

  it('answers with a contract-valid snapshot', async () => {
    const adapter = createDemoAdapter(memoryStorage());
    const snapshot = await adapter.snapshot(DEMO_TRIP_ID);
    expect(snapshotResponse.parse(snapshot)).toBeTruthy();
    expect(snapshot.members).toHaveLength(4);
    // One day path per trip date, never a sparse list.
    expect(snapshot.day_paths.map((day) => day.date)).toEqual(snapshot.trip.dates);
  });

  it('serves only the simulated trip, so demo state cannot leak into a real one', async () => {
    const adapter = createDemoAdapter(memoryStorage());
    await expect(adapter.snapshot('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('appends chat and replays a retried send instead of duplicating it', async () => {
    const adapter = createDemoAdapter(memoryStorage());
    const nonce = '22222222-2222-4222-8222-222222222222';
    const first = await adapter.sendMessage(DEMO_TRIP_ID, { body: 'Museum?', client_nonce: nonce });
    expect(createMessageResponse.parse(first).deduplicated).toBe(false);

    const retry = await adapter.sendMessage(DEMO_TRIP_ID, { body: 'Museum?', client_nonce: nonce });
    expect(retry.deduplicated).toBe(true);
    expect(retry.message.id).toBe(first.message.id);

    const page = await adapter.messages(DEMO_TRIP_ID);
    expect(listMessagesResponse.parse(page)).toBeTruthy();
    expect(page.messages.filter((row) => row.client_nonce === nonce)).toHaveLength(1);
  });

  it('opts the author into an event it creates and reflects it in budgets and paths', async () => {
    const adapter = createDemoAdapter(memoryStorage());
    const created = await adapter.createEvent(DEMO_TRIP_ID, eventRequest());
    expect(eventMutationResponse.parse(created)).toBeTruthy();

    const snapshot = await adapter.snapshot(DEMO_TRIP_ID);
    snapshotResponse.parse(snapshot);

    const author = snapshot.self_person_id;
    expect(created.attendance).toEqual([
      expect.objectContaining({ person_id: author, state: 'in' }),
    ]);

    const budget = snapshot.budgets.find((row) => row.person_id === author);
    expect(budget?.known_spend_cents).toBe(2500);
    expect(budget?.confirmed_subtotal_cents).toBe(2500);
    expect(budget?.status).toBe('within');

    const day = snapshot.day_paths.find((entry) => entry.date === '2026-10-09');
    expect(day?.nodes).toHaveLength(1);
    // No venue means no coordinates, so the stop is honestly unresolved.
    expect(day?.nodes[0]?.unresolved).toBe(true);
    expect(day?.idle_member_ids).toHaveLength(3);
  });

  it('rejects an edit against a stale version and reports the current one', async () => {
    const adapter = createDemoAdapter(memoryStorage());
    await adapter.createEvent(DEMO_TRIP_ID, eventRequest());
    await expect(adapter.createEvent(DEMO_TRIP_ID, eventRequest())).rejects.toMatchObject({
      code: 'STALE_VERSION',
      currentCalendarVersion: '2',
    });
  });

  it('refuses a fourth simultaneous event', async () => {
    const adapter = createDemoAdapter(memoryStorage());
    let version = '1';
    for (const label of ['One', 'Two', 'Three']) {
      const result = await adapter.createEvent(
        DEMO_TRIP_ID,
        eventRequest({ label, expected_calendar_version: version }),
      );
      version = result.calendar_version;
    }
    await expect(
      adapter.createEvent(
        DEMO_TRIP_ID,
        eventRequest({ label: 'Four', expected_calendar_version: version }),
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
  });

  it('deletes an event once its last attendee opts out', async () => {
    const adapter = createDemoAdapter(memoryStorage());
    const created = await adapter.createEvent(DEMO_TRIP_ID, eventRequest());

    const result = await adapter.setSelfAttendance(DEMO_TRIP_ID, created.event.id, {
      idempotency_key: idem,
      expected_calendar_version: created.calendar_version,
      state: 'out',
    });
    expect(attendanceMutationResponse.parse(result).event).toBeNull();

    const snapshot = await adapter.snapshot(DEMO_TRIP_ID);
    expect(snapshot.events).toHaveLength(0);
    expect(snapshot.recent_deletions[0]?.reason).toBe('auto_zero_attendance');
  });

  it('switches simulated participant without touching identity', async () => {
    const adapter = createDemoAdapter(memoryStorage());
    const demo = adapter.demo;
    expect(demo).not.toBeNull();
    const second = demo?.participants()[1];
    demo?.switchParticipant(second?.id ?? '');
    const snapshot = await adapter.snapshot(DEMO_TRIP_ID);
    expect(snapshot.self_person_id).toBe(second?.id);
  });

  it('persists across reloads and restores the seed on reset', async () => {
    const storage = memoryStorage();
    const first = createDemoAdapter(storage);
    await first.sendMessage(DEMO_TRIP_ID, {
      body: 'Still here?',
      client_nonce: '33333333-3333-4333-8333-333333333333',
    });

    const reloaded = createDemoAdapter(storage);
    const before = await reloaded.messages(DEMO_TRIP_ID);
    expect(before.messages.some((row) => row.body === 'Still here?')).toBe(true);

    reloaded.demo?.reset();
    const after = await reloaded.messages(DEMO_TRIP_ID);
    expect(after.messages.some((row) => row.body === 'Still here?')).toBe(false);
  });

  it('reports an unimplemented operation as unavailable rather than faking it', async () => {
    const adapter = createDemoAdapter(memoryStorage());
    expect(adapter.capabilities.requestProcessing).toBe(false);
    await expect(
      adapter.requestProcessing(DEMO_TRIP_ID, { idempotency_key: idem }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
});

describe('live adapter', () => {
  it('never exposes demo controls or demo capabilities', () => {
    const adapter = createLiveAdapter();
    expect(adapter.demo).toBeNull();
    expect(adapter.capabilities.participantSwitching).toBe(false);
    expect(adapter.capabilities.reset).toBe(false);
  });

  it('reports operations the server does not implement as unavailable', async () => {
    const adapter = createLiveAdapter();
    expect(adapter.capabilities.manualEvents).toBe(false);
    await expect(adapter.createEvent(DEMO_TRIP_ID, eventRequest())).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
  });

  it('surfaces a transport failure instead of falling back to fixtures', async () => {
    const adapter = createLiveAdapter();
    const result = await adapter.snapshot(DEMO_TRIP_ID).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ApiRequestError);
    expect(result).not.toHaveProperty('members');
  });
});
