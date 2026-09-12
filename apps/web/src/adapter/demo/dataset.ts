import { personColor, type ProcessingStatusResource } from '@trip/contracts';
import type { DemoState } from './state';

/** Bumping this discards any stored demo state written by an older build. */
export const DEMO_SCHEMA = 1;

/**
 * The demo trip lives at one fixed, obviously-simulated id. Every demo read and
 * write is scoped to it, which is what keeps simulated state in its own
 * namespace and out of any real trip.
 */
export const DEMO_TRIP_ID = '00000000-0d30-4000-8000-000000000001';

const PERSON_IDS = [
  '00000000-0d30-4000-8000-0000000000a1',
  '00000000-0d30-4000-8000-0000000000a2',
  '00000000-0d30-4000-8000-0000000000a3',
  '00000000-0d30-4000-8000-0000000000a4',
] as const;

const SEEDED_AT = '2026-09-12T14:00:00-04:00';

const IDLE_PROCESSING: ProcessingStatusResource = {
  state: 'idle',
  batch_id: null,
  attempts: 0,
  next_attempt_at: null,
  // No worker and no provider are involved in a simulated session, and saying
  // so is more honest than reporting a healthy pipeline that does not exist.
  worker_available: false,
  provider_available: false,
  pending_user_message_count: 0,
  last_processed_message_id: '0',
  last_error_code: null,
  updated_at: SEEDED_AT,
};

/**
 * Seed for the simulated trip.
 *
 * Deliberately thin at this point: four participants, three Pittsburgh dates
 * and a short opening exchange. Events, venues and the scripted scenarios are
 * DATA-1 and DEMO-1 work, and venue coordinates, hours and prices must be
 * verified before they are added rather than invented here.
 */
export function seedDemoState(): DemoState {
  const members = [
    { name: 'Ana', budget: 40_000 },
    { name: 'Ben', budget: 25_000 },
    { name: 'Cleo', budget: 60_000 },
    { name: 'Dev', budget: 30_000 },
  ].map((person, index) => ({
    id: PERSON_IDS[index] ?? PERSON_IDS[0],
    display_name: person.name,
    color_index: index,
    color: personColor(index),
    budget_cents: person.budget,
    joined_at: SEEDED_AT,
  }));

  const self = members[0];
  if (self === undefined) throw new Error('demo seed must define at least one participant');

  return {
    schema: DEMO_SCHEMA,
    calendar_version: '1',
    active_person_id: self.id,
    trip: {
      id: DEMO_TRIP_ID,
      trip_name: 'Pittsburgh weekend',
      group_name: 'Demo crew',
      expected_headcount: members.length,
      destination_label: 'Pittsburgh, Pennsylvania',
      // Pittsburgh city centre, used only to centre the map view.
      destination_center: { lat: 40.4406, lon: -79.9959 },
      destination_bounds: null,
      timezone: 'America/New_York',
      currency: 'USD',
      creator_person_id: self.id,
      start_date: '2026-10-09',
      end_date: '2026-10-11',
      dates: ['2026-10-09', '2026-10-10', '2026-10-11'],
      created_at: SEEDED_AT,
    },
    members,
    events: [],
    attendance: [],
    places: [],
    messages: [
      {
        id: '1',
        kind: 'system',
        author_person_id: null,
        body: 'Simulated trip. Nothing here is saved to a real account.',
        created_at: SEEDED_AT,
        reply_to_message_id: null,
        referenced_event_id: null,
        client_nonce: null,
        batch_id: null,
        metadata: null,
      },
      {
        id: '2',
        kind: 'user',
        author_person_id: members[1]?.id ?? self.id,
        body: 'Three days in Pittsburgh. What does everyone want to do?',
        created_at: SEEDED_AT,
        reply_to_message_id: null,
        referenced_event_id: null,
        client_nonce: null,
        batch_id: null,
        metadata: null,
      },
    ],
    deletions: [],
    actions: [],
    next_message_id: '3',
    processing: IDLE_PROCESSING,
  };
}
