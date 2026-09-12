import { z } from 'zod';
import {
  bigintString,
  cents,
  eventLabel,
  localDate,
  locationQuery,
  minuteOfDay,
  uuid,
} from './primitives.js';
import { PROCESSING_LIMITS } from './limits.js';

/**
 * The bounded operation envelope the model is allowed to propose.
 *
 * The model proposes data only. Structured output establishes neither consent
 * nor business correctness: every field below is re-validated against database
 * state, and evidence is checked against same-trip messages actually authored
 * by the person whose consent is claimed.
 */

/** Messages authored by the named person that evidence their own consent. */
export const consentEvidence = z.strictObject({
  person_id: uuid,
  evidence_message_ids: z.array(bigintString).min(1).max(10),
});
export type ConsentEvidence = z.infer<typeof consentEvidence>;

const operationBase = {
  /**
   * Messages that triggered this operation. At least one must fall inside the
   * current batch range; historical context alone can never act.
   */
  source_message_ids: z.array(bigintString).min(1).max(10),
};

/** A venue the model may name. It never supplies coordinates or hours. */
export const llmPlaceRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('known'), place_id: uuid }),
  z.strictObject({ kind: z.literal('query'), query: locationQuery }),
]);

export const createEventOperation = z.strictObject({
  op: z.literal('create_event'),
  ...operationBase,
  label: eventLabel,
  local_date: localDate,
  start_minute: minuteOfDay,
  duration_minutes: z.int().min(1).max(1440),
  place: llmPlaceRef.nullable(),
  /** Estimate only. null is unknown; 0 is an explicit free. */
  estimated_price_cents: cents.nullable(),
  /** Two distinct people minimum, each with their own authored evidence. */
  attendees: z.array(consentEvidence).min(2).max(12),
  /** Set only for an explicit revival of this exact prior occurrence. */
  revive_tombstone_id: uuid.nullable(),
});

export const assignOperation = z.strictObject({
  op: z.literal('assign'),
  ...operationBase,
  event_id: uuid,
  attendee: consentEvidence,
});

export const deassignOperation = z.strictObject({
  op: z.literal('deassign'),
  ...operationBase,
  event_id: uuid,
  attendee: consentEvidence,
});

/** Creates a Remove/Keep button. Never mutates the calendar by itself. */
export const suggestRemoveOperation = z.strictObject({
  op: z.literal('suggest_remove'),
  ...operationBase,
  event_id: uuid,
  reason: z.string().min(1).max(280),
});

/** Atomic move. Never renames, relocates, reprices or changes the roster. */
export const rescheduleEventOperation = z.strictObject({
  op: z.literal('reschedule_event'),
  ...operationBase,
  event_id: uuid,
  local_date: localDate,
  start_minute: minuteOfDay,
  end_minute: minuteOfDay,
  movers: z.array(consentEvidence).min(2).max(12),
});

export const llmOperation = z.discriminatedUnion('op', [
  createEventOperation,
  assignOperation,
  deassignOperation,
  suggestRemoveOperation,
  rescheduleEventOperation,
]);
export type LlmOperation = z.infer<typeof llmOperation>;
export type LlmOperationKind = LlmOperation['op'];

export const llmClarification = z.strictObject({
  source_message_id: bigintString,
  text: z.string().min(1).max(400),
});

export const llmEnvelope = z.strictObject({
  operations: z.array(llmOperation).max(PROCESSING_LIMITS.maxOperations),
  clarifications: z.array(llmClarification).max(PROCESSING_LIMITS.maxClarifications),
});
export type LlmEnvelope = z.infer<typeof llmEnvelope>;

/** Why the server refused a syntactically valid operation. Recorded per batch. */
export const operationRejectionCode = z.enum([
  'unknown_reference',
  'cross_trip_reference',
  'insufficient_consent',
  'evidence_not_authored_by_person',
  'no_current_batch_trigger',
  'human_decision_protected',
  'schedule_locked_by_human',
  'duplicate_of_active_event',
  'tombstone_requires_explicit_revival',
  'revival_requires_fresh_consent',
  'ambiguous_day_or_time',
  'date_outside_trip',
  'invalid_interval',
  'overlap_capacity_exceeded',
  'live_event_capacity_exceeded',
  'conflicting_operation_group',
  'forward_reference_to_new_event',
  'stale_event_revision',
  'attendee_count_below_minimum',
]);
export type OperationRejectionCode = z.infer<typeof operationRejectionCode>;
