import { z } from 'zod';
import {
  bigintString,
  cents,
  coordinate,
  displayName,
  eventLabel,
  groupName,
  isoTimestamp,
  localDate,
  minuteOfDay,
  placeLabel,
  timezoneName,
  tripName,
  uuid,
} from './primitives.js';
import {
  actorKind,
  attendanceState,
  botActionChoice,
  botActionStatus,
  botActionType,
  budgetStatus,
  eventDeletionReason,
  hoursProvenance,
  messageKind,
  placeResolution,
  priceSource,
  processingState,
} from './domain.js';
import { CURRENCY } from './limits.js';

/** Trip metadata that every member may read. Never includes invite tokens. */
export const tripResource = z.strictObject({
  id: uuid,
  trip_name: tripName,
  group_name: groupName,
  expected_headcount: z.int().min(1).max(12),
  destination_label: z.string().min(1).max(160),
  destination_center: coordinate,
  destination_bounds: z
    .strictObject({
      min_lat: z.number(),
      min_lon: z.number(),
      max_lat: z.number(),
      max_lon: z.number(),
    })
    .nullable(),
  timezone: timezoneName,
  currency: z.literal(CURRENCY),
  /**
   * Resolved creator membership. Only the creator may rotate invite links, so
   * the UI needs this to show the right affordance instead of discovering a
   * 403. The creator's auth user id stays server-private.
   */
  creator_person_id: uuid,
  start_date: localDate,
  end_date: localDate,
  /** Every actual trip date, inclusive, in trip-local order. */
  dates: z.array(localDate).min(1).max(7),
  created_at: isoTimestamp,
});
export type TripResource = z.infer<typeof tripResource>;

export const personResource = z.strictObject({
  id: uuid,
  display_name: displayName,
  /** Immutable palette index assigned at join. Calendar and map share it. */
  color_index: z.int().min(0).max(11),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  budget_cents: cents,
  joined_at: isoTimestamp,
});
export type PersonResource = z.infer<typeof personResource>;

export const openingIntervalResource = z.strictObject({
  start_minute: minuteOfDay,
  end_minute: minuteOfDay,
});

/**
 * One entry per trip date for which a schedule is actually known.
 * An entry with zero intervals means known closed. A date with no entry at all
 * means unknown, which is never the same thing as closed.
 */
export const openingHoursDayResource = z.strictObject({
  date: localDate,
  intervals: z.array(openingIntervalResource),
});

export const placeResource = z.strictObject({
  id: uuid,
  label: placeLabel,
  address: z.string().max(400).nullable(),
  provider_place_id: z.string().max(200).nullable(),
  /** Both coordinates are present or both absent; never one of the two. */
  coordinate: coordinate.nullable(),
  resolution: placeResolution,
  revision: bigintString,
  hours_days: z.array(openingHoursDayResource),
  hours_provenance: hoursProvenance.nullable(),
  hours_observed_at: isoTimestamp.nullable(),
  human_override: z.boolean(),
});
export type PlaceResource = z.infer<typeof placeResource>;

export const eventResource = z.strictObject({
  id: uuid,
  place_id: uuid.nullable(),
  label: eventLabel,
  local_date: localDate,
  start_minute: minuteOfDay,
  end_minute: minuteOfDay,
  starts_at: isoTimestamp,
  ends_at: isoTimestamp,
  /** null is unknown cost. 0 is an explicit free. */
  price_cents: cents.nullable(),
  price_source: priceSource.nullable(),
  created_by: actorKind,
  created_by_person_id: uuid.nullable(),
  /** A human time edit or manual creation pins the schedule against extraction. */
  schedule_locked_by_human: z.boolean(),
  revision: bigintString,
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});
export type EventResource = z.infer<typeof eventResource>;

export const attendanceResource = z.strictObject({
  event_id: uuid,
  person_id: uuid,
  state: attendanceState,
  set_by: actorKind,
  updated_at: isoTimestamp,
});
export type AttendanceResource = z.infer<typeof attendanceResource>;

export const deletedEventResource = z.strictObject({
  event_id: uuid,
  label: eventLabel,
  local_date: localDate,
  start_minute: minuteOfDay,
  reason: eventDeletionReason,
  deleted_by_person_id: uuid.nullable(),
  deleted_at: isoTimestamp,
  revision: bigintString,
  tombstone_id: uuid.nullable(),
});
export type DeletedEventResource = z.infer<typeof deletedEventResource>;

export const personBudgetResource = z.strictObject({
  person_id: uuid,
  budget_cents: cents,
  /**
   * Sum of known prices over live, in-attended events only.
   * Always equals estimate_subtotal_cents + confirmed_subtotal_cents.
   */
  known_spend_cents: z.int().min(0),
  /** Prices sourced from the model. Estimates, never authoritative. */
  estimate_subtotal_cents: z.int().min(0),
  /**
   * Prices a human confirmed plus manually verified seed prices. Both are
   * trustworthy, so they share one subtotal; label it accordingly rather than
   * as "confirmed" alone.
   */
  confirmed_subtotal_cents: z.int().min(0),
  /** Live in-attended events with no known price. Drives the unknown status. */
  unknown_price_event_count: z.int().min(0),
  status: budgetStatus,
});
export type PersonBudgetResource = z.infer<typeof personBudgetResource>;

/**
 * What the planner does not know. Kept in the snapshot rather than posted to
 * chat so unknown data is visible without flooding the transcript.
 *
 * An event with no venue at all is not unknown coverage: "Game night" has
 * nothing to resolve. Only events whose `place_id` is set, and whose place
 * lacks coordinates or lacks a schedule for that exact date, belong in the
 * place and hours arrays.
 */
export const unknownCoverageResource = z.strictObject({
  /** Live events whose price_cents is null. Zero is a known price, not unknown. */
  unknown_price_event_ids: z.array(uuid),
  /** Events with a place that has no coordinates yet. Never placeless events. */
  unresolved_place_event_ids: z.array(uuid),
  /** Events with a place that has no stored schedule for that date. */
  unknown_hours_event_ids: z.array(uuid),
});
export type UnknownCoverageResource = z.infer<typeof unknownCoverageResource>;

const warningBase = {
  key: z.string().min(1).max(400),
  person_id: uuid.nullable(),
  event_ids: z.array(uuid),
  active: z.boolean(),
  activated_at_version: bigintString,
  resolved_at_version: bigintString.nullable(),
};

export const warningResource = z.discriminatedUnion('kind', [
  z.strictObject({
    ...warningBase,
    kind: z.literal('double_booking'),
    details: z.strictObject({ overlap_minutes: z.int().min(1) }),
  }),
  z.strictObject({
    ...warningBase,
    kind: z.literal('insufficient_travel_time'),
    details: z.strictObject({
      distance_km: z.number().nonnegative().nullable(),
      required_minutes: z.int().min(0).nullable(),
      available_minutes: z.int(),
    }),
  }),
  z.strictObject({
    ...warningBase,
    kind: z.literal('budget_exceeded'),
    details: z.strictObject({ budget_cents: cents, known_spend_cents: z.int().min(0) }),
  }),
  z.strictObject({
    ...warningBase,
    kind: z.literal('outside_opening_hours'),
    details: z.strictObject({
      place_id: uuid,
      stored_intervals: z.array(openingIntervalResource),
      provenance: hoursProvenance.nullable(),
    }),
  }),
  z.strictObject({
    ...warningBase,
    kind: z.literal('venue_closed'),
    details: z.strictObject({ place_id: uuid, provenance: hoursProvenance.nullable() }),
  }),
]);
export type WarningResource = z.infer<typeof warningResource>;

export const botActionResource = z.strictObject({
  id: uuid,
  type: botActionType,
  status: botActionStatus,
  /**
   * Which buttons to render, derived by the server from the action type and
   * the caller's permissions. The client must not hardcode the type-to-choice
   * mapping; an empty array means the action is visible but not actionable.
   */
  available_choices: z.array(botActionChoice),
  source_message_id: bigintString,
  target_event_id: uuid.nullable(),
  target_tombstone_id: uuid.nullable(),
  /** The action is bound to this revision; a later revision makes it stale. */
  expected_event_revision: bigintString.nullable(),
  resolved_by_person_id: uuid.nullable(),
  created_at: isoTimestamp,
  resolved_at: isoTimestamp.nullable(),
});
export type BotActionResource = z.infer<typeof botActionResource>;

/**
 * Server-derived prefix tree over per-person ordered event sequences for one
 * date. Calendar and map consume this same projection so their colors and
 * branches cannot diverge.
 */
export const dayPathNodeResource = z.strictObject({
  /**
   * Derived deterministically from the event-id path to this node, so the same
   * unchanged day always yields the same ids. These are React and map layer
   * keys: ids that move between refetches remount every marker on each poll.
   */
  id: z.string().min(1).max(200),
  parent_id: z.string().min(1).max(200).nullable(),
  /**
   * Two nodes may share an event_id when separate histories reconverge on the
   * same event. The map draws one marker per event_id; the prefix tree keeps
   * the distinct histories.
   */
  event_id: uuid,
  depth: z.int().min(0),
  /** Colours come from members[].color. There is no second colour source. */
  member_ids: z.array(uuid).min(1),
  coordinate: coordinate.nullable(),
  /** True when the event has no usable coordinates yet. */
  unresolved: z.boolean(),
  warning_keys: z.array(z.string()),
});

export const dayPathEdgeResource = z.strictObject({
  /** Deterministic, like node ids. */
  id: z.string().min(1).max(400),
  /**
   * Endpoint node ids, not event ids, so an edge travelled in the opposite
   * direction stays a distinct edge rather than collapsing into this one.
   */
  from_node_id: z.string().min(1).max(200),
  to_node_id: z.string().min(1).max(200),
  member_ids: z.array(uuid).min(1),
  /** false when either endpoint lacks coordinates; never draw a fabricated leg. */
  drawable: z.boolean(),
  distance_km: z.number().nonnegative().nullable(),
  required_minutes: z.int().min(0).nullable(),
  warning_keys: z.array(z.string()),
});

/**
 * Exactly one of these per entry in trip.dates, always. A day with nothing
 * planned has empty nodes and edges and every member in idle_member_ids, so
 * the map can tell "no events that day" from "the server omitted the day".
 */
export const dayPathResource = z.strictObject({
  date: localDate,
  nodes: z.array(dayPathNodeResource),
  edges: z.array(dayPathEdgeResource),
  /** Members with no attended live event that day. An empty path is valid. */
  idle_member_ids: z.array(uuid),
});
export type DayPathResource = z.infer<typeof dayPathResource>;

export const processingStatusResource = z.strictObject({
  state: processingState,
  batch_id: uuid.nullable(),
  attempts: z.int().min(0),
  next_attempt_at: isoTimestamp.nullable(),
  /**
   * Derived from a compatible worker heartbeat; the heartbeat row stays
   * private. When this is false, `state` reads `unavailable` regardless of
   * what the trip last recorded, so build UI copy from the triple
   * (state, worker_available, pending_user_message_count).
   */
  worker_available: z.boolean(),
  /** False when the provider is switched off or its daily ceiling is spent. */
  provider_available: z.boolean(),
  pending_user_message_count: z.int().min(0),
  last_processed_message_id: bigintString,
  /** Sanitized code only. Never a provider or SQL message. */
  last_error_code: z.string().max(80).nullable(),
  updated_at: isoTimestamp,
});
export type ProcessingStatusResource = z.infer<typeof processingStatusResource>;

export const messageResource = z.strictObject({
  id: bigintString,
  kind: messageKind,
  author_person_id: uuid.nullable(),
  body: z.string(),
  created_at: isoTimestamp,
  reply_to_message_id: bigintString.nullable(),
  referenced_event_id: uuid.nullable(),
  client_nonce: uuid.nullable(),
  batch_id: uuid.nullable(),
  /** Server-authored structured context for bot and system messages. */
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type MessageResource = z.infer<typeof messageResource>;
