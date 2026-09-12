import { describe, expect, it } from 'vitest';
import { snapshotResponse, placeMutationResponse, type SnapshotResponse } from '@trip/contracts';
import { createDemoAdapter } from '../../apps/web/src/adapter/demo/adapter';
import { DEMO_TRIP_ID, PERSON, PLACE } from '../../apps/web/src/adapter/demo/dataset';
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

function adapter(): PlannerAdapter {
  return createDemoAdapter(memoryStorage(), { processingMs: 0 });
}

async function play(target: PlannerAdapter, ...ids: string[]): Promise<SnapshotResponse> {
  for (const id of ids) {
    target.demo?.runScenario(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));
}

const key = { idempotency_key: 'demo-breadth-key-1' };

describe('stored actions', () => {
  it('suggests a removal without changing anything until a person chooses', async () => {
    const target = adapter();
    const snapshot = await play(target, 'museum-agreement', 'dinner-overspend', 'suggest-remove');

    const action = snapshot.actions[0];
    expect(action?.type).toBe('remove_suggestion');
    expect(action?.status).toBe('pending');
    expect(action?.available_choices).toEqual(['remove', 'keep']);
    // The suggestion alone must not touch the calendar.
    expect(snapshot.events.some((event) => event.id === action?.target_event_id)).toBe(true);
  });

  it('Keep dismisses the suggestion and leaves the event alone', async () => {
    const target = adapter();
    let snapshot = await play(target, 'museum-agreement', 'dinner-overspend', 'suggest-remove');
    const action = snapshot.actions[0];

    const result = await target.resolveAction(DEMO_TRIP_ID, action?.id ?? '', {
      ...key,
      expected_calendar_version: snapshot.calendar_version,
      choice: 'keep',
    });
    expect(result.status).toBe('dismissed');

    snapshot = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));
    expect(snapshot.events.some((event) => event.label === 'Group dinner')).toBe(true);
    expect(snapshot.actions[0]?.status).toBe('dismissed');
  });

  it('Remove deletes the event and cannot be pressed twice', async () => {
    const target = adapter();
    let snapshot = await play(target, 'museum-agreement', 'dinner-overspend', 'suggest-remove');
    const action = snapshot.actions[0];

    await target.resolveAction(DEMO_TRIP_ID, action?.id ?? '', {
      ...key,
      expected_calendar_version: snapshot.calendar_version,
      choice: 'remove',
    });
    snapshot = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));

    expect(snapshot.events.some((event) => event.label === 'Group dinner')).toBe(false);
    expect(snapshot.recent_deletions.some((row) => row.label === 'Group dinner')).toBe(true);
    // Ben's overspend clears with the event that caused it.
    expect(snapshot.budgets.find((row) => row.person_id === PERSON.ben)?.status).not.toBe('over');

    // One-shot: replaying it changes nothing more.
    const replay = await target.resolveAction(DEMO_TRIP_ID, action?.id ?? '', {
      ...key,
      expected_calendar_version: snapshot.calendar_version,
      choice: 'remove',
    });
    expect(replay.status).toBe('stale');
  });

  it('refuses an action bound to a revision the event has moved past', async () => {
    const target = adapter();
    let snapshot = await play(target, 'museum-agreement', 'dinner-overspend', 'suggest-remove');
    const action = snapshot.actions[0];

    // Somebody edits the event after the suggestion was stored.
    await target.patchEvent(DEMO_TRIP_ID, action?.target_event_id ?? '', {
      idempotency_key: 'demo-breadth-key-2',
      expected_calendar_version: snapshot.calendar_version,
      label: 'Group dinner (moved)',
    });
    snapshot = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));

    const result = await target.resolveAction(DEMO_TRIP_ID, action?.id ?? '', {
      ...key,
      expected_calendar_version: snapshot.calendar_version,
      choice: 'remove',
    });
    expect(result.status).toBe('stale');
    // Nothing was deleted on a stale action.
    snapshot = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));
    expect(snapshot.events.some((event) => event.label === 'Group dinner (moved)')).toBe(true);
  });
});

describe('revival and Undo', () => {
  it('reopens the original event and offers an Undo bound to it', async () => {
    const target = adapter();
    let snapshot = await play(target, 'museum-agreement', 'dinner-overspend', 'suggest-remove');
    const suggestion = snapshot.actions[0];
    const originalId = suggestion?.target_event_id;

    await target.resolveAction(DEMO_TRIP_ID, suggestion?.id ?? '', {
      ...key,
      expected_calendar_version: snapshot.calendar_version,
      choice: 'remove',
    });
    snapshot = await play(target, 'revive-dinner');

    // The original id is reopened, not a fresh one.
    expect(snapshot.events.some((event) => event.id === originalId)).toBe(true);
    expect(snapshot.recent_deletions.some((row) => row.event_id === originalId)).toBe(false);

    const undo = snapshot.actions.find((action) => action.type === 'revival_undo');
    expect(undo?.available_choices).toEqual(['undo']);
    expect(undo?.status).toBe('pending');
  });

  it('Undo restores the deleted state, and a later edit makes it stale', async () => {
    const target = adapter();
    let snapshot = await play(target, 'museum-agreement', 'dinner-overspend', 'suggest-remove');
    await target.resolveAction(DEMO_TRIP_ID, snapshot.actions[0]?.id ?? '', {
      ...key,
      expected_calendar_version: snapshot.calendar_version,
      choice: 'remove',
    });
    snapshot = await play(target, 'revive-dinner');
    const undo = snapshot.actions.find((action) => action.type === 'revival_undo');

    const result = await target.resolveAction(DEMO_TRIP_ID, undo?.id ?? '', {
      ...key,
      expected_calendar_version: snapshot.calendar_version,
      choice: 'undo',
    });
    expect(result.status).toBe('applied');

    snapshot = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));
    expect(snapshot.events.some((event) => event.label === 'Group dinner')).toBe(false);
    expect(snapshot.recent_deletions.some((row) => row.label === 'Group dinner')).toBe(true);
  });

  it('will not play a scenario whose prerequisite has not happened', () => {
    const target = adapter();
    expect(() => target.demo?.runScenario('revive-dinner')).toThrow();
    expect(target.demo?.scenarios().find((s) => s.id === 'revive-dinner')?.eligible).toBe(false);
  });
});

describe('manual venue correction', () => {
  it('records coordinates and hours as a human override', async () => {
    const target = adapter();
    const before = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));

    const result = await target.patchPlace(DEMO_TRIP_ID, PLACE.phipps, {
      ...key,
      expected_calendar_version: before.calendar_version,
      choice: {
        kind: 'manual',
        coordinate: { lat: 40.4389, lon: -79.9477 },
        hours_days: [{ date: '2026-10-11', intervals: [{ start_minute: 600, end_minute: 1020 }] }],
      },
    });
    placeMutationResponse.parse(result);
    expect(result.place.human_override).toBe(true);
    expect(result.place.hours_provenance).toBe('human');

    // The Sunday visit sits inside those hours, so no warning is raised.
    const after = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));
    expect(after.warnings.filter((w) => w.kind === 'outside_opening_hours')).toEqual([]);
    expect(after.unknown_coverage.unknown_hours_event_ids).not.toContain(
      after.events.find((e) => e.place_id === PLACE.phipps)?.id,
    );
  });

  it('raises an hours warning when the correction does not cover the visit', async () => {
    const target = adapter();
    const before = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));
    await target.patchPlace(DEMO_TRIP_ID, PLACE.phipps, {
      ...key,
      expected_calendar_version: before.calendar_version,
      // The Sunday visit runs 11:00-13:00, so this closes before it ends.
      choice: {
        kind: 'manual',
        hours_days: [{ date: '2026-10-11', intervals: [{ start_minute: 600, end_minute: 720 }] }],
      },
    });

    const after = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));
    const warning = after.warnings.find((w) => w.kind === 'outside_opening_hours');
    expect(warning).toBeDefined();
    if (warning?.kind === 'outside_opening_hours') {
      expect(warning.details.provenance).toBe('human');
    }
  });
});

describe('per-person calendar export', () => {
  it("exports only the caller's own attended events", async () => {
    const target = adapter();
    await play(target, 'museum-agreement');

    // Ana attends the Friday walk and the museum; not the Sunday conservatory.
    const ana = await target.exportSelfCalendar(DEMO_TRIP_ID);
    expect(ana.filename).toBe('ana-trip.ics');
    expect(ana.content).toContain('BEGIN:VCALENDAR');
    expect(ana.content).toContain('END:VCALENDAR');
    expect(ana.content).toContain('Walk out to the Point');
    expect(ana.content).toContain('Carnegie Museum of Art');
    expect(ana.content).not.toContain('Phipps Conservatory');

    // Cleo's calendar is a different calendar.
    target.demo?.switchParticipant(PERSON.cleo);
    const cleo = await target.exportSelfCalendar(DEMO_TRIP_ID);
    expect(cleo.filename).toBe('cleo-trip.ics');
    expect(cleo.content).toContain('Phipps Conservatory');
    expect(cleo.content).not.toContain('Carnegie Museum of Art');
  });

  it('writes real UTC instants and one stable id per event revision', async () => {
    const target = adapter();
    const file = await target.exportSelfCalendar(DEMO_TRIP_ID);
    const snapshot = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));
    const walk = snapshot.events.find((event) => event.label === 'Walk out to the Point');

    // 17:00 in New York on 9 October is 21:00 UTC.
    expect(file.content).toContain('DTSTART:20261009T210000Z');
    expect(file.content).toContain(`UID:${walk?.id ?? ''}-${walk?.revision ?? ''}`);
  });

  it('drops an event from the file as soon as you leave it', async () => {
    const target = adapter();
    const snapshot = snapshotResponse.parse(await target.snapshot(DEMO_TRIP_ID));
    const walk = snapshot.events.find((event) => event.label === 'Walk out to the Point');

    await target.setSelfAttendance(DEMO_TRIP_ID, walk?.id ?? '', {
      ...key,
      expected_calendar_version: snapshot.calendar_version,
      state: 'out',
    });

    const file = await target.exportSelfCalendar(DEMO_TRIP_ID);
    expect(file.content).not.toContain('Walk out to the Point');
  });
});
