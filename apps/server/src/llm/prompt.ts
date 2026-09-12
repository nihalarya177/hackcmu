import { PROCESSING_LIMITS } from '@trip/contracts';

/**
 * Prompt and response schema, versioned together with the model.
 *
 * Every batch records which of the three it used, so an output can always be
 * traced to the exact instructions that produced it.
 */
export const PROMPT_VERSION = '1';
export const SCHEMA_VERSION = '1';

export const SYSTEM_PROMPT = `You read a group chat about one trip and propose calendar operations.

You propose data. You never decide anything: every field you emit is re-checked
against the database, and anything unsupported is discarded.

Rules you must follow:

1. Consent is per person and must be authored. An operation that commits a
   person requires a message THAT PERSON wrote saying so. One person cannot
   agree on behalf of another, and you must never infer consent from silence,
   from a question, or from someone else reporting it.
2. create_event needs at least two distinct attendees, each with their own
   evidence message ids. List EVERY attendee inside the create_event
   operation itself.
   The person who proposes something IS one of those attendees when they
   phrased it inclusively. "Let's do X", "lets go to X", "how about we do X",
   "shall we do X" all mean the speaker is going, and their own proposal
   message is their evidence. Only a detached suggestion — "you two should do
   X", "X is supposed to be good" — leaves the proposer out.
   So a proposal plus one other person saying yes is already two people.
3. assign and deassign only work on an event that already exists, using an
   event_id copied from EVENTS ALREADY PLANNED. Never emit assign for an event
   you are creating in this same response, and never emit a null event_id: an
   operation that refers to nothing is discarded.
4. Only act on what the latest messages ask for. Older messages may supply
   detail for an operation the new messages trigger, but they can never
   trigger one on their own.
5. Use the trip's own dates. If a day or time is genuinely ambiguous, do not
   guess: emit a clarification instead.
   duration_minutes is how long people actually spend there, not a default.
   A major museum or zoo is half a day, a gallery or a viewpoint an hour or
   two, a sit-down meal about ninety minutes, a show its running time. Use
   what was said whenever a length or an end time was given.
6. estimated_price_cents is required on every create_event. Give a number.
   It is what ONE person pays, in cents: 2500 means $25.00.
   Use the price somebody stated if they stated one. Otherwise estimate what
   that kind of place normally costs — a major museum or theme park, a zoo, a
   funicular, a bar, a restaurant all have a usual price, and you know roughly
   what it is. Use 0 for things that really are free, like a public park.
   Use null ONLY when there is no such thing as a price, such as meeting at
   somebody's flat. "I am not certain" is not a reason to use null: an
   estimate that is roughly right is far more useful than a blank, it is
   stored and shown as an estimate rather than a quoted price, and anybody can
   correct it in one click.
   Do not invent an address, coordinates or opening hours: those come from a
   real geocoder, not from you.
7. To move an existing event use reschedule_event, which changes only the
   time. To change who is going use assign or deassign. To propose dropping
   something use suggest_remove, which only creates a button for a person to
   press.
8. If nothing in the new messages calls for a change, return no operations —
   but say why in a clarification, pointing at the message that came closest.
   Returning both arrays empty tells the group nothing, and silence reads as
   the planner being broken. The only time both may be empty is when the new
   messages are pure chatter with nothing planning-related in them at all.

Emit at most ${PROCESSING_LIMITS.maxOperations} operations and ${PROCESSING_LIMITS.maxClarifications} clarifications.`;

/**
 * The provider-side schema.
 *
 * One variant per operation kind, each with its own required fields. This
 * matters: with a single loose shape the model omits the optional fields it
 * needs most — it proposed an event with no attendees and then tried to assign
 * people to it by id before it existed. Requiring the fields per kind is what
 * makes a complete, self-contained operation the only valid answer.
 *
 * It is still not the gate. Everything here is re-parsed by the Zod contract
 * and then re-checked against the database.
 */
const CONSENT = {
  type: 'object',
  properties: {
    person_id: { type: 'string' },
    evidence_message_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['person_id', 'evidence_message_ids'],
} as const;

const SOURCE_IDS = { type: 'array', items: { type: 'string' } } as const;

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['create_event'] },
              source_message_ids: SOURCE_IDS,
              label: { type: 'string' },
              local_date: { type: 'string' },
              start_minute: { type: 'integer' },
              duration_minutes: { type: 'integer' },
              estimated_price_cents: { type: 'integer', nullable: true },
              place_query: { type: 'string', nullable: true },
              place_id: { type: 'string', nullable: true },
              revive_tombstone_id: { type: 'string', nullable: true },
              attendees: { type: 'array', items: CONSENT },
            },
            // Required, not because null is disallowed, but because an
            // optional nullable field invites the model to skip it: every
            // price came back null while it was optional.
            required: [
              'op',
              'source_message_ids',
              'label',
              'local_date',
              'start_minute',
              'duration_minutes',
              'attendees',
              'estimated_price_cents',
            ],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['assign', 'deassign'] },
              source_message_ids: SOURCE_IDS,
              event_id: { type: 'string' },
              attendee: CONSENT,
            },
            required: ['op', 'source_message_ids', 'event_id', 'attendee'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['suggest_remove'] },
              source_message_ids: SOURCE_IDS,
              event_id: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['op', 'source_message_ids', 'event_id', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['reschedule_event'] },
              source_message_ids: SOURCE_IDS,
              event_id: { type: 'string' },
              local_date: { type: 'string' },
              start_minute: { type: 'integer' },
              end_minute: { type: 'integer' },
              movers: { type: 'array', items: CONSENT },
            },
            required: [
              'op',
              'source_message_ids',
              'event_id',
              'local_date',
              'start_minute',
              'end_minute',
              'movers',
            ],
          },
        ],
      },
    },
    clarifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source_message_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['source_message_id', 'text'],
      },
    },
  },
  required: ['operations', 'clarifications'],
} as const;

export interface PromptContext {
  timezone: string;
  dates: string[];
  members: { id: string; name: string }[];
  events: {
    id: string;
    label: string;
    local_date: string;
    start_minute: number;
    end_minute: number;
    attendees: string[];
    locked: boolean;
  }[];
  tombstones: { id: string; label: string; date: string }[];
  /** Messages before the batch range. Context only; they cannot trigger. */
  history: { id: string; author: string | null; body: string }[];
  /** The messages this batch is answering. At least one must trigger anything. */
  current: { id: string; author: string | null; body: string }[];
}

/** The user turn: state first, then history, then what is actually new. */
export function buildUserPrompt(context: PromptContext): string {
  const people = context.members.map((m) => `${m.id} = ${m.name}`).join('\n');
  const events =
    context.events.length === 0
      ? '(none)'
      : context.events
          .map(
            (e) =>
              `${e.id} "${e.label}" ${e.local_date} ${minutes(e.start_minute)}-${minutes(e.end_minute)} attendees=[${e.attendees.join(', ')}]${e.locked ? ' TIME_LOCKED_BY_HUMAN' : ''}`,
          )
          .join('\n');
  const tombstones =
    context.tombstones.length === 0
      ? '(none)'
      : context.tombstones.map((t) => `${t.id} "${t.label}" ${t.date}`).join('\n');

  return `TRIP
timezone: ${context.timezone}
dates: ${context.dates.join(', ')}

PEOPLE (person_id = name)
${people}

EVENTS ALREADY PLANNED
${events}

PREVIOUSLY DELETED (tombstone_id, for explicit revival only)
${tombstones}

EARLIER MESSAGES (context only — these cannot trigger an operation)
${format(context.history)}

NEW MESSAGES (this batch — at least one of these must justify each operation)
${format(context.current)}`;
}

function format(rows: { id: string; author: string | null; body: string }[]): string {
  if (rows.length === 0) return '(none)';
  return rows.map((row) => `[${row.id}] ${row.author ?? 'system'}: ${row.body}`).join('\n');
}

function minutes(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
