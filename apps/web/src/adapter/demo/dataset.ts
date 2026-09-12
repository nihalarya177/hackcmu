import { personColor, type PlaceResource, type ProcessingStatusResource } from '@trip/contracts';
import type { DemoState } from './state';

/** Bumping this discards any stored demo state written by an older build. */
export const DEMO_SCHEMA = 2;

/**
 * The demo trip lives at one fixed, obviously-simulated id. Every demo read and
 * write is scoped to it, which is what keeps simulated state in its own
 * namespace and out of any real trip.
 */
export const DEMO_TRIP_ID = '00000000-0d30-4000-8000-000000000001';

export const PERSON = {
  ana: '00000000-0d30-4000-8000-0000000000a1',
  ben: '00000000-0d30-4000-8000-0000000000a2',
  cleo: '00000000-0d30-4000-8000-0000000000a3',
  dev: '00000000-0d30-4000-8000-0000000000a4',
} as const;

export const PLACE = {
  museum: '00000000-0d30-4000-8000-0000000000b1',
  phipps: '00000000-0d30-4000-8000-0000000000b2',
  incline: '00000000-0d30-4000-8000-0000000000b3',
  point: '00000000-0d30-4000-8000-0000000000b4',
} as const;

export const DEMO_DATES = ['2026-10-09', '2026-10-10', '2026-10-11'] as const;

const SEEDED_AT = '2026-09-12T14:00:00-04:00';

/**
 * Venue coordinates taken from Wikipedia on 2026-09-12 and stored as manual
 * entries, which is what they are: nobody called a geocoder. Opening hours are
 * deliberately absent — no exact-date schedule was verified for these trip
 * dates, and unknown hours must read as unknown rather than as open.
 *
 *   Carnegie Museum of Art  https://en.wikipedia.org/wiki/Carnegie_Museum_of_Art
 *   Phipps Conservatory     https://en.wikipedia.org/wiki/Phipps_Conservatory_and_Botanical_Gardens
 *   Duquesne Incline        https://en.wikipedia.org/wiki/Duquesne_Incline
 *   Point State Park        https://en.wikipedia.org/wiki/Point_State_Park
 */
function seedPlaces(): PlaceResource[] {
  const base = {
    provider_place_id: null,
    resolution: 'manual' as const,
    revision: '1',
    hours_days: [],
    hours_provenance: null,
    hours_observed_at: null,
    human_override: false,
  };
  return [
    {
      ...base,
      id: PLACE.museum,
      label: 'Carnegie Museum of Art',
      address: '4400 Forbes Ave, Pittsburgh, PA 15213',
      coordinate: { lat: 40.44369, lon: -79.948976 },
    },
    {
      ...base,
      id: PLACE.phipps,
      label: 'Phipps Conservatory and Botanical Gardens',
      address: '1 Schenley Dr, Pittsburgh, PA 15213',
      coordinate: { lat: 40.438948, lon: -79.947705 },
    },
    {
      ...base,
      id: PLACE.incline,
      label: 'Duquesne Incline',
      address: '1197 W Carson St, Pittsburgh, PA 15219',
      coordinate: { lat: 40.43917, lon: -80.01806 },
    },
    {
      ...base,
      id: PLACE.point,
      label: 'Point State Park',
      address: '601 Commonwealth Pl, Pittsburgh, PA 15222',
      coordinate: { lat: 40.4417, lon: -80.00719 },
    },
  ];
}

/**
 * A simulated worker and provider. They are reported as available because the
 * scripted pipeline does respond; the persistent Demo mode indicator is what
 * tells the viewer no real model is involved.
 */
const SEED_PROCESSING: ProcessingStatusResource = {
  state: 'idle',
  batch_id: null,
  attempts: 0,
  next_attempt_at: null,
  worker_available: true,
  provider_available: true,
  pending_user_message_count: 5,
  last_processed_message_id: '0',
  last_error_code: null,
  updated_at: SEEDED_AT,
};

const MEMBERS = [
  { key: 'ana', name: 'Ana', budget_cents: 40_000 },
  { key: 'ben', name: 'Ben', budget_cents: 12_000 },
  { key: 'cleo', name: 'Cleo', budget_cents: 60_000 },
  { key: 'dev', name: 'Dev', budget_cents: 30_000 },
] as const;

/**
 * Seed for the simulated trip.
 *
 * One evening already planned, so the calendar is not empty, and an opening
 * exchange that the scripted scenarios cite as their evidence. Saturday is left
 * open on purpose: it is what the demo builds during the presentation.
 */
export function seedDemoState(): DemoState {
  const members = MEMBERS.map((person, index) => ({
    id: PERSON[person.key],
    display_name: person.name,
    color_index: index,
    color: personColor(index),
    budget_cents: person.budget_cents,
    joined_at: SEEDED_AT,
  }));

  const openingWalk = {
    id: '00000000-0d30-4000-8000-0000000000c1',
    place_id: PLACE.point,
    label: 'Walk out to the Point',
    local_date: DEMO_DATES[0],
    start_minute: 1020,
    end_minute: 1110,
    starts_at: '2026-10-09T17:00:00-04:00',
    ends_at: '2026-10-09T18:30:00-04:00',
    // The park is free to enter; zero is a known price, not an unknown one.
    price_cents: 0,
    price_source: 'seeded' as const,
    created_by: 'human' as const,
    created_by_person_id: PERSON.ana,
    schedule_locked_by_human: true,
    revision: '1',
    created_at: SEEDED_AT,
    updated_at: SEEDED_AT,
  };

  const phippsVisit = {
    id: '00000000-0d30-4000-8000-0000000000c6',
    place_id: PLACE.phipps,
    label: 'Phipps Conservatory',
    local_date: DEMO_DATES[2],
    start_minute: 660,
    end_minute: 780,
    starts_at: '2026-10-11T11:00:00-04:00',
    ends_at: '2026-10-11T13:00:00-04:00',
    // Illustrative estimate, not a quoted admission price.
    price_cents: 2000,
    price_source: 'estimate' as const,
    created_by: 'human' as const,
    created_by_person_id: PERSON.cleo,
    schedule_locked_by_human: true,
    revision: '1',
    created_at: SEEDED_AT,
    updated_at: SEEDED_AT,
  };

  const message = (
    id: string,
    author: string | null,
    body: string,
    kind: 'user' | 'system' = 'user',
  ) => ({
    id,
    kind,
    author_person_id: author,
    body,
    created_at: SEEDED_AT,
    reply_to_message_id: null,
    referenced_event_id: null,
    client_nonce: null,
    batch_id: null,
    metadata: null,
  });

  return {
    schema: DEMO_SCHEMA,
    calendar_version: '1',
    active_person_id: PERSON.ana,
    trip: {
      id: DEMO_TRIP_ID,
      trip_name: 'Pittsburgh weekend',
      group_name: 'Demo crew',
      expected_headcount: members.length,
      destination_label: 'Pittsburgh, Pennsylvania',
      destination_center: { lat: 40.4406, lon: -79.9959 },
      destination_bounds: null,
      timezone: 'America/New_York',
      currency: 'USD',
      creator_person_id: PERSON.ana,
      start_date: DEMO_DATES[0],
      end_date: DEMO_DATES[2],
      dates: [...DEMO_DATES],
      created_at: SEEDED_AT,
    },
    members,
    places: seedPlaces(),
    events: [openingWalk, phippsVisit],
    attendance: [
      ...members.map((person) => ({
        event_id: openingWalk.id,
        person_id: person.id,
        state: 'in' as const,
        set_by: 'human' as const,
        updated_at: SEEDED_AT,
      })),
      ...[PERSON.cleo, PERSON.dev].map((personId) => ({
        event_id: phippsVisit.id,
        person_id: personId,
        state: 'in' as const,
        set_by: 'human' as const,
        updated_at: SEEDED_AT,
      })),
    ],
    messages: [
      message('1', null, 'Simulated trip. Nothing here is saved to a real account.', 'system'),
      message('2', PERSON.ben, 'Three days in Pittsburgh. What does everyone want to do?'),
      message('3', PERSON.ana, "I'd like the Carnegie Museum of Art on Saturday morning."),
      message('4', PERSON.ben, 'The art museum works for me Saturday too.'),
      message(
        '5',
        PERSON.cleo,
        'Dev and I did that last trip — we were thinking the Duquesne Incline instead.',
      ),
      message('6', PERSON.dev, 'I put Phipps down for Sunday late morning.'),
    ],
    deletions: [],
    actions: [],
    applied_scenarios: [],
    next_message_id: '7',
    processing: SEED_PROCESSING,
  };
}
