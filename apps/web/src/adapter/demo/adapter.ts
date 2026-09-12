import { DateTime } from 'luxon';
import {
  TRIP_LIMITS,
  compareVersions,
  type AttendanceResource,
  type CreateEventRequest,
  type DeletedEventResource,
  type EventResource,
  type ListMessagesQuery,
  type ListMessagesResponse,
  type MessageResource,
  type PatchEventRequest,
  type PatchSelfPersonRequest,
  type PatchTripRequest,
  type PutSelfAttendanceRequest,
  type RequestProcessingResponse,
} from '@trip/contracts';
import { ApiRequestError, UnsupportedOperationError } from '../../lib/apiError';
import type { Capabilities, DemoControls, PlannerAdapter } from '../types';
import { DEMO_TRIP_ID } from './dataset';
import { matchScenario, scenarioById, SCENARIOS, type Scenario } from './scenarios';
import { deriveSnapshot } from './derive';
import type { DemoState } from './state';
import { DemoStore } from './store';

/**
 * Implemented against the simulated state today. Place search, stored bot
 * actions and export are DEMO-2/DEMO-3 work and stay false until they exist,
 * so no control is offered with nothing behind it.
 */
const DEMO_CAPABILITIES: Capabilities = {
  chat: true,
  invite: false,
  selfProfile: true,
  tripSettings: true,
  manualEvents: true,
  eventRestore: true,
  selfAttendance: true,
  places: false,
  botActions: false,
  requestProcessing: true,
  export: false,
  participantSwitching: true,
  reset: true,
};

/**
 * The demo does its work synchronously, but the boundary is asynchronous. This
 * keeps a rejected promise the only failure channel: a method that threw
 * inline would bypass every `.catch` the UI has.
 */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** How long the simulated extraction appears to run. */
export const DEMO_PROCESSING_MS = 900;

function unsupported(operation: string): never {
  throw new UnsupportedOperationError('demo', operation);
}

function fail(
  code: 'NOT_FOUND' | 'STALE_VERSION' | 'CAPACITY_EXCEEDED' | 'UNPROCESSABLE' | 'FORBIDDEN',
  message: string,
  currentCalendarVersion?: string,
): never {
  throw new ApiRequestError(code, message, {
    requestId: 'demo',
    currentCalendarVersion: currentCalendarVersion ?? null,
  });
}

/**
 * Demo mode.
 *
 * Needs no credentials, no API and no database. Every response is built from
 * local simulated state and validated by the same contracts the live adapter
 * parses, so the UI cannot tell the two apart by shape — only by `mode`.
 */
export function createDemoAdapter(
  storage: Storage | null,
  options: { processingMs?: number } = {},
): PlannerAdapter {
  const store = new DemoStore(storage);
  const processingMs = options.processingMs ?? DEMO_PROCESSING_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Rejects any id but the simulated trip, so demo state stays namespaced. */
  const scoped = (tripId: string): DemoState => {
    if (tripId !== DEMO_TRIP_ID) fail('NOT_FOUND', 'Demo mode only serves the simulated trip');
    return store.state;
  };

  const requireVersion = (state: DemoState, expected: string): void => {
    if (compareVersions(expected, state.calendar_version) !== 0) {
      fail('STALE_VERSION', 'The plan changed since this edit began', state.calendar_version);
    }
  };

  /** Every mutation bumps the version, exactly as a real commit would. */
  const commit = (state: DemoState, changes: Partial<DemoState>): DemoState => {
    const next: DemoState = {
      ...state,
      ...changes,
      calendar_version: (BigInt(state.calendar_version) + 1n).toString(),
    };
    store.update(next);
    return next;
  };

  const instant = (state: DemoState, date: string, minute: number): string => {
    const value = DateTime.fromISO(date, { zone: state.trip.timezone }).plus({ minutes: minute });
    // Second precision, matching the seeded instants.
    const iso = value.toISO({ suppressMilliseconds: true });
    if (iso === null) fail('UNPROCESSABLE', `${date} is not a valid date in the trip timezone`);
    return iso;
  };

  const self = (state: DemoState): string => state.active_person_id;

  const botMessage = (
    state: DemoState,
    body: string,
    batchId: string | null,
    metadata: Record<string, unknown>,
  ): MessageResource => ({
    id: state.next_message_id,
    kind: 'bot',
    author_person_id: null,
    body,
    created_at: nowIso(),
    reply_to_message_id: null,
    referenced_event_id: null,
    client_nonce: null,
    batch_id: batchId,
    metadata,
  });

  /** Applies one scripted scenario's fixed effects, then posts what it did. */
  const applyScenario = (state: DemoState, scenario: Scenario, batchId: string): void => {
    let events = [...state.events];
    let attendance = [...state.attendance];
    let places = [...state.places];
    const at = nowIso();

    for (const op of scenario.ops) {
      if (op.kind === 'create_event') {
        const event: EventResource = {
          id: op.event_id,
          place_id: op.place_id,
          label: op.label,
          local_date: op.local_date,
          start_minute: op.start_minute,
          end_minute: op.end_minute,
          starts_at: instant(state, op.local_date, op.start_minute),
          ends_at: instant(state, op.local_date, op.end_minute),
          price_cents: op.price_cents,
          // Demo prices are illustrative, so they never claim to be confirmed.
          price_source: op.price_cents === null ? null : 'estimate',
          created_by: 'llm',
          created_by_person_id: null,
          // A scripted outcome does not pin the schedule; a human edit does.
          schedule_locked_by_human: false,
          revision: '1',
          created_at: at,
          updated_at: at,
        };
        assertOverlapRoom({ ...state, events }, event);
        events = [...events, event];
        attendance = [
          ...attendance,
          ...op.attendees.map((personId) => ({
            event_id: event.id,
            person_id: personId,
            state: 'in' as const,
            set_by: 'llm' as const,
            updated_at: at,
          })),
        ];
        continue;
      }

      if (op.kind === 'add_attendee') {
        const already = attendance.some(
          (row) => row.event_id === op.event_id && row.person_id === op.person_id,
        );
        if (already) continue;
        attendance = [
          ...attendance,
          {
            event_id: op.event_id,
            person_id: op.person_id,
            state: 'in',
            set_by: 'llm',
            updated_at: at,
          },
        ];
        continue;
      }

      places = places.map((place) =>
        place.id === op.place_id
          ? {
              ...place,
              hours_days: [
                ...place.hours_days.filter((day) => day.date !== op.date),
                {
                  date: op.date,
                  intervals: op.intervals.map(([start, end]) => ({
                    start_minute: start,
                    end_minute: end,
                  })),
                },
              ],
              // A person recorded this, so it reads as a human correction.
              hours_provenance: 'human' as const,
              hours_observed_at: at,
              human_override: true,
              revision: (BigInt(place.revision) + 1n).toString(),
            }
          : place,
      );
    }

    commit(state, {
      events,
      attendance,
      places,
      messages: [
        ...state.messages,
        botMessage(state, scenario.says, batchId, {
          simulated: true,
          scenario_id: scenario.id,
          evidence_message_ids: scenario.evidence,
        }),
      ],
      next_message_id: (BigInt(state.next_message_id) + 1n).toString(),
      applied_scenarios: [...state.applied_scenarios, scenario.id],
      processing: {
        ...state.processing,
        state: 'idle',
        batch_id: null,
        attempts: 0,
        next_attempt_at: null,
        last_error_code: null,
        pending_user_message_count: 0,
        last_processed_message_id: state.next_message_id,
        updated_at: at,
      },
    });
  };

  /** Nothing scripted applies. Say so; never improvise a plan. */
  const clarify = (state: DemoState, batchId: string): void => {
    commit(state, {
      messages: [
        ...state.messages,
        botMessage(
          state,
          'No scripted demo scenario matches that yet, so nothing was changed. The demo only plays back named scenarios.',
          batchId,
          { simulated: true, scenario_id: null, unmatched: true },
        ),
      ],
      next_message_id: (BigInt(state.next_message_id) + 1n).toString(),
      processing: {
        ...state.processing,
        state: 'idle',
        batch_id: null,
        attempts: 0,
        next_attempt_at: null,
        last_error_code: null,
        pending_user_message_count: 0,
        last_processed_message_id: state.next_message_id,
        updated_at: nowIso(),
      },
    });
  };

  const finishRun = (batchId: string, scenarioId: string | null): void => {
    timer = null;
    const state = store.state;
    if (state.processing.batch_id !== batchId) return;

    const scenario = scenarioId === null ? null : scenarioById(scenarioId);

    // One scripted failure, so manual Retry has something real to retry.
    if (scenario?.failsFirst === true && state.processing.attempts === 0) {
      commit(state, {
        processing: {
          ...state.processing,
          state: 'failed',
          batch_id: null,
          attempts: 1,
          next_attempt_at: null,
          last_error_code: 'provider_unavailable',
          updated_at: nowIso(),
        },
      });
      return;
    }

    try {
      if (scenario === null) clarify(state, batchId);
      else applyScenario(state, scenario, batchId);
    } catch {
      // A scripted effect that no longer fits the edited plan fails the batch
      // rather than half-applying it.
      commit(state, {
        processing: {
          ...state.processing,
          state: 'failed',
          batch_id: null,
          attempts: state.processing.attempts + 1,
          last_error_code: 'scenario_not_applicable',
          updated_at: nowIso(),
        },
      });
    }
  };

  const beginRun = (state: DemoState, forced: Scenario | null): RequestProcessingResponse => {
    if (state.processing.state === 'queued' || state.processing.state === 'running') {
      return { state: state.processing.state, batch_id: state.processing.batch_id, queued: false };
    }

    const transcript = state.messages
      .filter((row) => row.kind === 'user')
      .map((row) => row.body)
      .join('\n');
    const scenario = forced ?? matchScenario(transcript, state.applied_scenarios);

    // Nothing pending and nothing scripted left: a no-op, not a fake batch.
    if (scenario === null && state.processing.pending_user_message_count === 0) {
      return { state: state.processing.state, batch_id: null, queued: false };
    }

    const batchId = newUuid();
    commit(state, {
      processing: {
        ...state.processing,
        state: 'queued',
        batch_id: batchId,
        next_attempt_at: null,
        last_error_code: null,
        updated_at: nowIso(),
      },
    });

    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => finishRun(batchId, scenario?.id ?? null), processingMs);
    return { state: 'queued', batch_id: batchId, queued: true };
  };

  const demo: DemoControls = {
    tripId: DEMO_TRIP_ID,
    participants: () => store.state.members,
    activePersonId: () => store.state.active_person_id,
    switchParticipant: (personId) => {
      if (!store.state.members.some((person) => person.id === personId)) {
        fail('NOT_FOUND', 'No such simulated participant');
      }
      store.update({ ...store.state, active_person_id: personId });
    },
    reset: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      store.reset();
    },
    scenarios: () =>
      SCENARIOS.map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        hint: scenario.hint,
        applied: store.state.applied_scenarios.includes(scenario.id),
      })),
    runScenario: (id) => {
      const scenario = scenarioById(id);
      if (scenario === null) fail('NOT_FOUND', 'No such demo scenario');
      beginRun(store.state, scenario);
    },
    subscribe: (listener) => store.subscribe(listener),
  };

  return {
    mode: 'demo',
    capabilities: DEMO_CAPABILITIES,
    demo,

    // No credentials, no network, no Auth. This is the whole point of the mode.
    start: () => Promise.resolve(),

    createTrip: () => settle(() => unsupported('createTrip')),
    previewInvite: () => settle(() => unsupported('previewInvite')),
    joinTrip: () => settle(() => unsupported('joinTrip')),
    mintInvite: () => settle(() => unsupported('mintInvite')),
    resolveAction: () => settle(() => unsupported('resolveAction')),
    requestProcessing: (tripId) => settle(() => beginRun(scoped(tripId), null)),

    snapshot: (tripId) => settle(() => deriveSnapshot(scoped(tripId), nowIso())),

    processing: (tripId) =>
      settle(() => {
        const state = scoped(tripId);
        return {
          calendar_version: state.calendar_version,
          processing: state.processing,
          server_time: nowIso(),
        };
      }),

    messages: (tripId, params = {}) => settle(() => pageMessages(scoped(tripId), params)),

    sendMessage: (tripId, body) =>
      settle(() => {
        const state = scoped(tripId);

        // A retried send must replay its row rather than duplicate it.
        const existing = state.messages.find((row) => row.client_nonce === body.client_nonce);
        if (existing !== undefined) {
          return { message: existing, deduplicated: true };
        }

        const message: MessageResource = {
          id: state.next_message_id,
          kind: 'user',
          author_person_id: self(state),
          body: body.body,
          created_at: nowIso(),
          reply_to_message_id: body.reply_to_message_id ?? null,
          referenced_event_id: body.referenced_event_id ?? null,
          client_nonce: body.client_nonce,
          batch_id: null,
          metadata: null,
        };
        commit(state, {
          messages: [...state.messages, message],
          next_message_id: (BigInt(state.next_message_id) + 1n).toString(),
          processing: {
            ...state.processing,
            pending_user_message_count: state.processing.pending_user_message_count + 1,
          },
        });
        return { message, deduplicated: false };
      }),

    patchSelf: (tripId, body: PatchSelfPersonRequest) =>
      settle(() => {
        const state = scoped(tripId);
        requireVersion(state, body.expected_calendar_version);
        const members = state.members.map((person) =>
          person.id === self(state)
            ? {
                ...person,
                display_name: body.display_name ?? person.display_name,
                budget_cents: body.budget_cents ?? person.budget_cents,
              }
            : person,
        );
        const next = commit(state, { members });
        const updated = next.members.find((person) => person.id === self(next));
        if (updated === undefined) fail('NOT_FOUND', 'No such simulated participant');
        return { calendar_version: next.calendar_version, person: updated };
      }),

    patchTrip: (tripId, body: PatchTripRequest) =>
      settle(() => {
        const state = scoped(tripId);
        requireVersion(state, body.expected_calendar_version);
        const next = commit(state, {
          trip: {
            ...state.trip,
            trip_name: body.trip_name ?? state.trip.trip_name,
            group_name: body.group_name ?? state.trip.group_name,
          },
        });
        return { calendar_version: next.calendar_version, trip: next.trip };
      }),

    createEvent: (tripId, body: CreateEventRequest) =>
      settle(() => {
        const state = scoped(tripId);
        requireVersion(state, body.expected_calendar_version);
        if (body.place !== null) unsupported('createEvent with a venue');
        if (body.end_minute <= body.start_minute) {
          fail('UNPROCESSABLE', 'An event must end after it starts');
        }
        if (!state.trip.dates.includes(body.local_date)) {
          fail('UNPROCESSABLE', 'That date is not part of the trip');
        }
        if (state.events.length >= TRIP_LIMITS.maxLiveEvents) {
          fail('CAPACITY_EXCEEDED', `A trip holds at most ${TRIP_LIMITS.maxLiveEvents} events`);
        }

        const created = nowIso();
        const event: EventResource = {
          id: newUuid(),
          place_id: null,
          label: body.label,
          local_date: body.local_date,
          start_minute: body.start_minute,
          end_minute: body.end_minute,
          starts_at: instant(state, body.local_date, body.start_minute),
          ends_at: instant(state, body.local_date, body.end_minute),
          price_cents: body.price_cents,
          price_source: body.price_source,
          created_by: 'human',
          created_by_person_id: self(state),
          // Manual creation pins the schedule against later extraction.
          schedule_locked_by_human: true,
          revision: '1',
          created_at: created,
          updated_at: created,
        };
        assertOverlapRoom(state, event);

        // Creating an event opts its author in; nobody else is committed.
        const attendance: AttendanceResource = {
          event_id: event.id,
          person_id: self(state),
          state: 'in',
          set_by: 'human',
          updated_at: created,
        };
        const next = commit(state, {
          events: [...state.events, event],
          attendance: [...state.attendance, attendance],
        });
        return {
          calendar_version: next.calendar_version,
          event,
          attendance: [attendance],
          place: null,
        };
      }),

    patchEvent: (tripId, eventId, body: PatchEventRequest) =>
      settle(() => {
        const state = scoped(tripId);
        requireVersion(state, body.expected_calendar_version);
        if (body.place !== undefined) unsupported('patchEvent with a venue');

        const current = state.events.find((event) => event.id === eventId);
        if (current === undefined) fail('NOT_FOUND', 'No such event');

        const localDate = body.local_date ?? current.local_date;
        const startMinute = body.start_minute ?? current.start_minute;
        const endMinute = body.end_minute ?? current.end_minute;
        if (endMinute <= startMinute) fail('UNPROCESSABLE', 'An event must end after it starts');
        if (!state.trip.dates.includes(localDate)) {
          fail('UNPROCESSABLE', 'That date is not part of the trip');
        }
        const timeChanged =
          localDate !== current.local_date ||
          startMinute !== current.start_minute ||
          endMinute !== current.end_minute;

        const updated: EventResource = {
          ...current,
          label: body.label ?? current.label,
          local_date: localDate,
          start_minute: startMinute,
          end_minute: endMinute,
          starts_at: instant(state, localDate, startMinute),
          ends_at: instant(state, localDate, endMinute),
          price_cents: 'price_cents' in body ? (body.price_cents ?? null) : current.price_cents,
          price_source: 'price_cents' in body ? (body.price_source ?? null) : current.price_source,
          schedule_locked_by_human: current.schedule_locked_by_human || timeChanged,
          revision: (BigInt(current.revision) + 1n).toString(),
          updated_at: nowIso(),
        };
        assertOverlapRoom(state, updated);

        const next = commit(state, {
          events: state.events.map((event) => (event.id === eventId ? updated : event)),
        });
        return {
          calendar_version: next.calendar_version,
          event: updated,
          attendance: next.attendance.filter((row) => row.event_id === eventId),
          place: null,
        };
      }),

    deleteEvent: (tripId, eventId, body) =>
      settle(() => {
        const state = scoped(tripId);
        requireVersion(state, body.expected_calendar_version);
        const event = state.events.find((row) => row.id === eventId);
        if (event === undefined) fail('NOT_FOUND', 'No such event');

        const deleted: DeletedEventResource = {
          event_id: event.id,
          label: event.label,
          local_date: event.local_date,
          start_minute: event.start_minute,
          reason: 'human',
          deleted_by_person_id: self(state),
          deleted_at: nowIso(),
          revision: (BigInt(event.revision) + 1n).toString(),
          tombstone_id: newUuid(),
        };
        const next = commit(state, {
          events: state.events.filter((row) => row.id !== eventId),
          attendance: state.attendance.filter((row) => row.event_id !== eventId),
          deletions: [...state.deletions, deleted],
        });
        return { calendar_version: next.calendar_version, deleted };
      }),

    restoreEvent: (tripId, eventId, body) =>
      settle(() => {
        const state = scoped(tripId);
        requireVersion(state, body.expected_calendar_version);
        const deleted = state.deletions.find((row) => row.event_id === eventId);
        if (deleted === undefined) fail('NOT_FOUND', 'No such deleted event');

        const restored = nowIso();
        // The original id is preserved, so references from chat still resolve.
        const event: EventResource = {
          id: deleted.event_id,
          place_id: null,
          label: deleted.label,
          local_date: deleted.local_date,
          start_minute: deleted.start_minute,
          end_minute: Math.min(deleted.start_minute + 90, 1440),
          starts_at: instant(state, deleted.local_date, deleted.start_minute),
          ends_at: instant(state, deleted.local_date, Math.min(deleted.start_minute + 90, 1440)),
          price_cents: null,
          price_source: null,
          created_by: 'human',
          created_by_person_id: self(state),
          schedule_locked_by_human: true,
          revision: (BigInt(deleted.revision) + 1n).toString(),
          created_at: restored,
          updated_at: restored,
        };
        assertOverlapRoom(state, event);

        const attendance: AttendanceResource = {
          event_id: event.id,
          person_id: self(state),
          state: 'in',
          set_by: 'human',
          updated_at: restored,
        };
        const next = commit(state, {
          events: [...state.events, event],
          attendance: [...state.attendance, attendance],
          deletions: state.deletions.filter((row) => row.event_id !== eventId),
        });
        return {
          calendar_version: next.calendar_version,
          event,
          attendance: [attendance],
          place: null,
        };
      }),

    setSelfAttendance: (tripId, eventId, body: PutSelfAttendanceRequest) =>
      settle(() => {
        const state = scoped(tripId);
        requireVersion(state, body.expected_calendar_version);
        const event = state.events.find((row) => row.id === eventId);
        if (event === undefined) fail('NOT_FOUND', 'No such event');

        const personId = self(state);
        const others = state.attendance.filter(
          (row) => !(row.event_id === eventId && row.person_id === personId),
        );
        // "undecided" is the absence of a row, not a third stored state.
        const rows: AttendanceResource[] =
          body.state === 'undecided'
            ? others
            : [
                ...others,
                {
                  event_id: eventId,
                  person_id: personId,
                  state: body.state,
                  set_by: 'human',
                  updated_at: nowIso(),
                },
              ];

        // An event nobody attends is gone, exactly as the live rule has it.
        const stillAttended = rows.some((row) => row.event_id === eventId && row.state === 'in');
        if (!stillAttended) {
          const deleted: DeletedEventResource = {
            event_id: event.id,
            label: event.label,
            local_date: event.local_date,
            start_minute: event.start_minute,
            reason: 'auto_zero_attendance',
            deleted_by_person_id: personId,
            deleted_at: nowIso(),
            revision: (BigInt(event.revision) + 1n).toString(),
            tombstone_id: newUuid(),
          };
          const next = commit(state, {
            events: state.events.filter((row) => row.id !== eventId),
            attendance: rows.filter((row) => row.event_id !== eventId),
            deletions: [...state.deletions, deleted],
          });
          return {
            calendar_version: next.calendar_version,
            event: null,
            attendance: [],
          };
        }

        const next = commit(state, { attendance: rows });
        return {
          calendar_version: next.calendar_version,
          event,
          attendance: next.attendance.filter((row) => row.event_id === eventId),
        };
      }),
  };
}

/** Global cap on simultaneous events, checked across the whole trip. */
function assertOverlapRoom(state: DemoState, candidate: EventResource): void {
  const clashing = state.events.filter(
    (event) =>
      event.id !== candidate.id &&
      event.local_date === candidate.local_date &&
      event.start_minute < candidate.end_minute &&
      candidate.start_minute < event.end_minute,
  );
  if (clashing.length + 1 > TRIP_LIMITS.maxOverlappingEvents) {
    fail(
      'CAPACITY_EXCEEDED',
      `At most ${TRIP_LIMITS.maxOverlappingEvents} events may run at the same time`,
    );
  }
}

function pageMessages(state: DemoState, params: Partial<ListMessagesQuery>): ListMessagesResponse {
  const ordered = [...state.messages].sort((a, b) => compareVersions(a.id, b.id));
  const limit = Math.min(params.limit ?? 50, TRIP_LIMITS.messagePageMax);

  const { before_id: before, after_id: after } = params;
  let page: MessageResource[];
  if (before !== undefined) {
    // Paging backwards still returns the page in ascending order.
    const older = ordered.filter((row) => compareVersions(row.id, before) < 0);
    page = older.slice(Math.max(0, older.length - limit));
  } else if (after !== undefined) {
    page = ordered.filter((row) => compareVersions(row.id, after) > 0).slice(0, limit);
  } else {
    page = ordered.slice(Math.max(0, ordered.length - limit));
  }

  const oldest = page[0];
  const newest = page[page.length - 1];
  return {
    messages: page,
    has_more: page.length < ordered.length,
    oldest_id: oldest?.id ?? null,
    newest_id: newest?.id ?? null,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function newUuid(): string {
  return crypto.randomUUID();
}
