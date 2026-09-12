import { DEMO_DATES, PERSON, PLACE } from './dataset';

/**
 * Scripted outcomes for the simulated planner.
 *
 * These are named, ordered transitions with fixed effects — not a language
 * model and not a parser. A scenario becomes eligible when its keywords appear
 * somewhere in the chat transcript, and each one applies at most once. When
 * nothing matches, the run says so rather than inventing a plan.
 */
export type ScenarioId =
  | 'museum-agreement'
  | 'incline-branch'
  | 'afternoon-walk'
  | 'dinner-overspend'
  | 'double-booking'
  | 'phipps-closed'
  | 'provider-failure';

export type ScenarioOp =
  | {
      kind: 'create_event';
      event_id: string;
      label: string;
      place_id: string | null;
      local_date: string;
      start_minute: number;
      end_minute: number;
      price_cents: number | null;
      attendees: string[];
    }
  | { kind: 'add_attendee'; event_id: string; person_id: string }
  | { kind: 'set_hours'; place_id: string; date: string; intervals: [number, number][] };

export type Scenario = {
  id: ScenarioId;
  title: string;
  /** What a presenter can say to reach it. Shown in the demo controls. */
  hint: string;
  /** Lowercase keywords; every one must appear somewhere in the transcript. */
  triggers: string[];
  /** Message ids whose authors are the evidence for this outcome. */
  evidence: string[];
  /** The chat line the simulated planner posts when it commits. */
  says: string;
  ops: ScenarioOp[];
  /** Fails the first attempt, so manual Retry has something to retry. */
  failsFirst?: boolean;
};

const EVENT = {
  museum: '00000000-0d30-4000-8000-0000000000c2',
  incline: '00000000-0d30-4000-8000-0000000000c3',
  walk: '00000000-0d30-4000-8000-0000000000c4',
  dinner: '00000000-0d30-4000-8000-0000000000c5',
} as const;

const SATURDAY = DEMO_DATES[1];
const SUNDAY = DEMO_DATES[2];

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'museum-agreement',
    title: 'Two people agree on the art museum',
    hint: 'Already evidenced by the opening messages.',
    triggers: ['museum'],
    evidence: ['3', '4'],
    says: 'Ana and Ben both asked for the Carnegie Museum of Art on Saturday morning, so it is on the calendar for the two of them. The $25 admission is an illustrative estimate.',
    ops: [
      {
        kind: 'create_event',
        event_id: EVENT.museum,
        label: 'Carnegie Museum of Art',
        place_id: PLACE.museum,
        local_date: SATURDAY,
        start_minute: 600,
        end_minute: 780,
        price_cents: 2500,
        attendees: [PERSON.ana, PERSON.ben],
      },
    ],
  },
  {
    id: 'incline-branch',
    title: 'The other pair picks a simultaneous alternative',
    hint: 'Already evidenced by the opening messages.',
    triggers: ['incline'],
    evidence: ['5'],
    says: 'Cleo and Dev are taking the Duquesne Incline at the same time instead. The group splits on Saturday morning; the $5 fare is an illustrative estimate.',
    ops: [
      {
        kind: 'create_event',
        event_id: EVENT.incline,
        label: 'Duquesne Incline',
        place_id: PLACE.incline,
        local_date: SATURDAY,
        start_minute: 630,
        end_minute: 720,
        price_cents: 500,
        attendees: [PERSON.cleo, PERSON.dev],
      },
    ],
  },
  {
    id: 'afternoon-walk',
    title: 'Everyone regroups downtown, too soon after the museum',
    hint: 'Try: "let us all meet at Point State Park right after".',
    triggers: ['point'],
    evidence: [],
    says: 'Point State Park is on for the whole group on Saturday afternoon. Ana and Ben are coming straight from Oakland, and the gap looks tight.',
    ops: [
      {
        kind: 'create_event',
        event_id: EVENT.walk,
        label: 'Regroup at the Point',
        place_id: PLACE.point,
        local_date: SATURDAY,
        start_minute: 790,
        end_minute: 900,
        price_cents: 0,
        attendees: [PERSON.ana, PERSON.ben, PERSON.cleo, PERSON.dev],
      },
    ],
  },
  {
    id: 'dinner-overspend',
    title: 'A pricey dinner pushes Ben over his budget',
    hint: 'Try: "let us book a nice dinner on Saturday".',
    triggers: ['dinner'],
    evidence: [],
    says: 'A Saturday dinner is booked for everyone. No venue was named, so the stop has no location yet, and $180 a head is an illustrative estimate rather than a quoted price.',
    ops: [
      {
        kind: 'create_event',
        event_id: EVENT.dinner,
        label: 'Group dinner',
        place_id: null,
        local_date: SATURDAY,
        start_minute: 1140,
        end_minute: 1290,
        price_cents: 18_000,
        attendees: [PERSON.ana, PERSON.ben, PERSON.cleo, PERSON.dev],
      },
    ],
  },
  {
    id: 'double-booking',
    title: 'Dev joins the museum while already on the incline',
    hint: 'Try: "Dev wants to see the museum as well".',
    triggers: ['dev', 'as well'],
    evidence: [],
    says: 'Dev is added to the museum visit. It runs at the same time as the incline, which Dev is also attending.',
    ops: [{ kind: 'add_attendee', event_id: EVENT.museum, person_id: PERSON.dev }],
  },
  {
    id: 'phipps-closed',
    title: 'A correction records Phipps as closed on Sunday',
    hint: 'Try: "someone checked, Phipps is closed Sunday".',
    triggers: ['phipps', 'closed'],
    evidence: [],
    says: 'Recorded that Phipps is closed on Sunday, from the person who checked. No schedule was looked up automatically.',
    ops: [{ kind: 'set_hours', place_id: PLACE.phipps, date: SUNDAY, intervals: [] }],
  },
  {
    id: 'provider-failure',
    title: 'The extraction fails once, then succeeds on retry',
    hint: 'Try: "plan something for Sunday morning".',
    triggers: ['sunday morning'],
    evidence: [],
    says: 'Sunday morning is still open — nothing in the conversation says what to put there yet.',
    ops: [],
    failsFirst: true,
  },
];

/**
 * The first unapplied scenario whose keywords all appear in the transcript.
 * Deliberately order-dependent and case-insensitive; nothing here infers
 * meaning it was not given.
 */
export function matchScenario(transcript: string, applied: readonly string[]): Scenario | null {
  const haystack = transcript.toLowerCase();
  return (
    SCENARIOS.find(
      (scenario) =>
        !applied.includes(scenario.id) &&
        scenario.triggers.every((keyword) => haystack.includes(keyword)),
    ) ?? null
  );
}

export function scenarioById(id: string): Scenario | null {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
