import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  TRIP_LIMITS,
  type ConsentEvidence,
  type LlmEnvelope,
  type LlmOperation,
  type OperationRejectionCode,
} from '@trip/contracts';
import { attendance, botAction, event, place, tombstone } from '@trip/db';
import { maxSimultaneous } from '../domain/derive.js';
import { eventInstants } from '../domain/instants.js';
import { bumpCalendarVersion } from '../domain/membership.js';
import { toEventResource } from '../domain/serializers.js';
import { deleteZeroAttendanceEvents, readTripState, reconcileWarnings } from '../domain/state.js';
import type { Tx } from '../domain/types.js';

export interface ApplyContext {
  tripId: string;
  timezone: string;
  dates: string[];
  /** Inclusive upper bound of the batch. Something inside it must trigger. */
  lowerExclusiveMsgId: bigint;
  upperInclusiveMsgId: bigint;
  batchId: string;
  memberIds: Set<string>;
  /** Message id to the person who wrote it. Consent is checked against this. */
  authorOf: Map<string, string | null>;
}

export interface Rejection {
  op: string;
  code: OperationRejectionCode;
}

export interface ApplyOutcome {
  accepted: number;
  rejections: Rejection[];
  notices: string[];
}

/**
 * Applies a validated envelope inside the caller's transaction.
 *
 * Every field the model produced is re-checked against database state here.
 * Structured output proves the shape and nothing else: it establishes neither
 * consent nor business correctness, and this is the only layer that decides
 * whether an operation actually happens.
 */
export async function applyEnvelope(
  tx: Tx,
  context: ApplyContext,
  envelope: LlmEnvelope,
): Promise<ApplyOutcome> {
  const rejections: Rejection[] = [];
  const notices: string[] = [];
  let accepted = 0;

  const conflicts = conflictingTargets(envelope.operations);

  for (const operation of envelope.operations) {
    const reject = (code: OperationRejectionCode): void => {
      rejections.push({ op: operation.op, code });
    };

    // An operation must be triggered by something in this batch. Older context
    // can supply detail, but it can never act on its own.
    if (!hasCurrentTrigger(operation, context)) {
      reject('no_current_batch_trigger');
      continue;
    }
    if (conflicts.has(targetKey(operation))) {
      reject('conflicting_operation_group');
      continue;
    }

    // Expected rejections are returned as codes, not thrown, so they need no
    // savepoint. An unexpected database failure propagates and aborts the
    // whole batch rather than leaving it half applied.
    const outcome = await applyOne(tx, context, operation);
    if (outcome === null) accepted += 1;
    else reject(outcome);
  }

  if (accepted > 0) {
    await deleteZeroAttendanceEvents(tx, context.tripId, null);
    const version = await bumpCalendarVersion(tx, context.tripId);
    const state = await readTripState(tx, context.tripId);
    await reconcileWarnings(tx, context.tripId, state, version);
  }

  for (const clarification of envelope.clarifications) {
    notices.push(clarification.text);
  }

  return { accepted, rejections, notices };
}

async function applyOne(
  tx: Tx,
  context: ApplyContext,
  operation: LlmOperation,
): Promise<OperationRejectionCode | null> {
  switch (operation.op) {
    case 'create_event':
      return createFromModel(tx, context, operation);
    case 'assign':
    case 'deassign':
      return changeRoster(tx, context, operation);
    case 'suggest_remove':
      return suggestRemove(tx, context, operation);
    case 'reschedule_event':
      return reschedule(tx, context, operation);
  }
}

/* -------------------------------------------------------------------------- */

async function createFromModel(
  tx: Tx,
  context: ApplyContext,
  operation: Extract<LlmOperation, { op: 'create_event' }>,
): Promise<OperationRejectionCode | null> {
  if (!context.dates.includes(operation.local_date)) return 'date_outside_trip';

  const consenting = operation.attendees.filter((row) => authored(context, row));
  if (consenting.length < operation.attendees.length) {
    return 'evidence_not_authored_by_person';
  }
  const distinct = new Set(consenting.map((row) => row.person_id));
  for (const id of distinct) if (!context.memberIds.has(id)) return 'unknown_reference';
  // Two people minimum, each speaking for themselves.
  if (distinct.size < 2) return 'attendee_count_below_minimum';

  const endMinute = Math.min(operation.start_minute + operation.duration_minutes, 1440);
  if (endMinute <= operation.start_minute) return 'invalid_interval';

  const live = await liveEvents(tx, context.tripId);
  if (live.length >= TRIP_LIMITS.maxLiveEvents) return 'live_event_capacity_exceeded';

  // A previous deletion of this same occurrence blocks silent recreation.
  const stones = await tx
    .select()
    .from(tombstone)
    .where(and(eq(tombstone.tripId, context.tripId), isNull(tombstone.clearedAt)));
  const normalized = operation.label.trim().toLowerCase();
  const blocking = stones.find(
    (stone) =>
      stone.occurrenceDate === operation.local_date &&
      stone.normalizedLabels.some((label) => label === normalized),
  );
  if (blocking !== undefined && operation.revive_tombstone_id !== blocking.id) {
    return 'tombstone_requires_explicit_revival';
  }

  // An identical live occurrence is a duplicate, not a second visit.
  const duplicate = live.find(
    (row) => row.localDate === operation.local_date && row.normalizedLabel === normalized,
  );
  if (duplicate !== undefined) return 'duplicate_of_active_event';

  const { startsAt, endsAt } = eventInstants(
    operation.local_date,
    operation.start_minute,
    endMinute,
    context.timezone,
  );

  const placeId = await resolveModelPlace(tx, context.tripId, operation.place);

  const inserted = await tx
    .insert(event)
    .values({
      tripId: context.tripId,
      placeId,
      label: operation.label,
      normalizedLabel: normalized,
      localDate: operation.local_date,
      startMinute: operation.start_minute,
      endMinute,
      startsAt,
      endsAt,
      priceCents: operation.estimated_price_cents,
      // Anything the model supplies is an estimate, never a confirmed price.
      priceSource: operation.estimated_price_cents === null ? null : 'estimate',
      createdBy: 'llm',
      createdByPersonId: null,
      creationBatchId: context.batchId,
      creationSourceMsgId: BigInt(operation.source_message_ids[0] ?? '0'),
      scheduleLockedByHuman: false,
      revision: 1n,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) return 'unknown_reference';

  if (
    maxSimultaneous([...live.map(toEventResource), toEventResource(row)], toEventResource(row)) >
    TRIP_LIMITS.maxOverlappingEvents
  ) {
    // Rolled back by the caller's savepoint-free path: reject before roster.
    await tx.delete(event).where(eq(event.id, row.id));
    return 'overlap_capacity_exceeded';
  }

  // Event and roster are created together or not at all.
  await tx.insert(attendance).values(
    [...distinct].map((personId) => ({
      tripId: context.tripId,
      eventId: row.id,
      personId,
      state: 'in' as const,
      setBy: 'llm' as const,
      evidenceMsgIds: evidenceOf(consenting, personId),
    })),
  );

  if (blocking !== undefined) {
    await tx
      .update(tombstone)
      .set({ clearedByBatchId: context.batchId, clearedAt: new Date() })
      .where(eq(tombstone.id, blocking.id));

    // Revival is reversible by a person, bound to this exact revision.
    await tx.insert(botAction).values({
      tripId: context.tripId,
      sourceMsgId: BigInt(operation.source_message_ids[0] ?? '0'),
      batchId: context.batchId,
      type: 'revival_undo',
      dedupeKey: `revival_undo:${row.id}:${context.batchId}`,
      targetEventId: row.id,
      targetTombstoneId: blocking.id,
      expectedEventRevision: row.revision,
      status: 'pending',
    });
  }

  return null;
}

async function changeRoster(
  tx: Tx,
  context: ApplyContext,
  operation: Extract<LlmOperation, { op: 'assign' | 'deassign' }>,
): Promise<OperationRejectionCode | null> {
  if (!authored(context, operation.attendee)) return 'evidence_not_authored_by_person';
  if (!context.memberIds.has(operation.attendee.person_id)) return 'unknown_reference';

  const rows = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.tripId, context.tripId),
        eq(event.id, operation.event_id),
        isNull(event.deletedAt),
      ),
    )
    .limit(1);
  const target = rows[0];
  if (target === undefined) return 'unknown_reference';

  const existing = await tx
    .select()
    .from(attendance)
    .where(
      and(
        eq(attendance.eventId, operation.event_id),
        eq(attendance.personId, operation.attendee.person_id),
      ),
    )
    .limit(1);

  // A person's own explicit choice outranks anything the model proposes.
  if (existing[0]?.setBy === 'human') return 'human_decision_protected';

  if (operation.op === 'assign') {
    await tx
      .insert(attendance)
      .values({
        tripId: context.tripId,
        eventId: operation.event_id,
        personId: operation.attendee.person_id,
        state: 'in',
        setBy: 'llm',
        evidenceMsgIds: operation.attendee.evidence_message_ids.map((id) => BigInt(id)),
      })
      .onConflictDoUpdate({
        target: [attendance.eventId, attendance.personId],
        set: { state: 'in', setBy: 'llm', updatedAt: new Date() },
      });
  } else {
    await tx
      .delete(attendance)
      .where(
        and(
          eq(attendance.eventId, operation.event_id),
          eq(attendance.personId, operation.attendee.person_id),
        ),
      );
  }

  await tx
    .update(event)
    .set({ revision: sql`${event.revision} + 1`, updatedAt: new Date() })
    .where(eq(event.id, target.id));
  return null;
}

async function suggestRemove(
  tx: Tx,
  context: ApplyContext,
  operation: Extract<LlmOperation, { op: 'suggest_remove' }>,
): Promise<OperationRejectionCode | null> {
  const rows = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.tripId, context.tripId),
        eq(event.id, operation.event_id),
        isNull(event.deletedAt),
      ),
    )
    .limit(1);
  const target = rows[0];
  if (target === undefined) return 'unknown_reference';

  // Deduplicated: the same suggestion from the same evidence proposes once.
  const dedupeKey = `remove:${target.id}:${operation.source_message_ids.join(',')}`;
  const already = await tx
    .select({ id: botAction.id })
    .from(botAction)
    .where(and(eq(botAction.tripId, context.tripId), eq(botAction.dedupeKey, dedupeKey)))
    .limit(1);
  if (already[0] !== undefined) return null;

  // Nothing is removed here: this only creates a button for a person to press.
  await tx.insert(botAction).values({
    tripId: context.tripId,
    sourceMsgId: BigInt(operation.source_message_ids[0] ?? '0'),
    batchId: context.batchId,
    type: 'remove_suggestion',
    dedupeKey,
    targetEventId: target.id,
    expectedEventRevision: target.revision,
    status: 'pending',
  });
  return null;
}

async function reschedule(
  tx: Tx,
  context: ApplyContext,
  operation: Extract<LlmOperation, { op: 'reschedule_event' }>,
): Promise<OperationRejectionCode | null> {
  if (!context.dates.includes(operation.local_date)) return 'date_outside_trip';
  if (operation.end_minute <= operation.start_minute) return 'invalid_interval';

  const rows = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.tripId, context.tripId),
        eq(event.id, operation.event_id),
        isNull(event.deletedAt),
      ),
    )
    .limit(1);
  const target = rows[0];
  if (target === undefined) return 'unknown_reference';
  // A person placed this deliberately; the model does not get to move it.
  if (target.scheduleLockedByHuman) return 'schedule_locked_by_human';

  const movers = operation.movers.filter((row) => authored(context, row));
  if (movers.length < operation.movers.length) return 'evidence_not_authored_by_person';

  const going = await tx
    .select({ personId: attendance.personId })
    .from(attendance)
    .where(and(eq(attendance.eventId, target.id), eq(attendance.state, 'in')));
  const goingIds = new Set(going.map((row) => row.personId));
  const consenting = new Set(movers.map((row) => row.person_id).filter((id) => goingIds.has(id)));
  if (consenting.size < 2) return 'insufficient_consent';

  const { startsAt, endsAt } = eventInstants(
    operation.local_date,
    operation.start_minute,
    operation.end_minute,
    context.timezone,
  );

  // The move preserves id, place, price and roster; only the time changes.
  const updated = await tx
    .update(event)
    .set({
      localDate: operation.local_date,
      startMinute: operation.start_minute,
      endMinute: operation.end_minute,
      startsAt,
      endsAt,
      revision: sql`${event.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(event.id, target.id))
    .returning();
  const row = updated[0];
  if (row === undefined) return 'unknown_reference';

  const live = await liveEvents(tx, context.tripId);
  if (
    maxSimultaneous(live.map(toEventResource), toEventResource(row)) >
    TRIP_LIMITS.maxOverlappingEvents
  ) {
    return 'overlap_capacity_exceeded';
  }
  return null;
}

/* -------------------------------------------------------------------------- */

async function liveEvents(tx: Tx, tripId: string) {
  return tx
    .select()
    .from(event)
    .where(and(eq(event.tripId, tripId), isNull(event.deletedAt)));
}

async function resolveModelPlace(
  tx: Tx,
  tripId: string,
  ref: { kind: 'known'; place_id: string } | { kind: 'query'; query: string } | null,
): Promise<string | null> {
  if (ref === null) return null;
  if (ref.kind === 'known') {
    const rows = await tx
      .select({ id: place.id })
      .from(place)
      .where(and(eq(place.tripId, tripId), eq(place.id, ref.place_id)))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  // The model names a venue in words and never supplies coordinates or hours.
  // It is stored unresolved for enrichment to pick up.
  const inserted = await tx
    .insert(place)
    .values({
      tripId,
      label: ref.query,
      normalizedLabel: ref.query.trim().toLowerCase(),
      searchQuery: ref.query,
      resolution: 'pending',
      revision: 1n,
    })
    .returning({ id: place.id });
  return inserted[0]?.id ?? null;
}

/** The claimed evidence must be a message that person actually wrote. */
function authored(context: ApplyContext, consent: ConsentEvidence): boolean {
  return consent.evidence_message_ids.some((id) => context.authorOf.get(id) === consent.person_id);
}

function evidenceOf(rows: ConsentEvidence[], personId: string): bigint[] {
  return rows
    .filter((row) => row.person_id === personId)
    .flatMap((row) => row.evidence_message_ids.map((id) => BigInt(id)));
}

function hasCurrentTrigger(operation: LlmOperation, context: ApplyContext): boolean {
  return operation.source_message_ids.some((id) => {
    const value = BigInt(id);
    return value > context.lowerExclusiveMsgId && value <= context.upperInclusiveMsgId;
  });
}

function targetKey(operation: LlmOperation): string {
  if (operation.op === 'create_event') return `create:${operation.label}:${operation.local_date}`;
  return `event:${operation.event_id}`;
}

/**
 * Groups that touch the same target in incompatible ways are all rejected,
 * rather than letting array order silently decide which one wins.
 */
function conflictingTargets(operations: LlmOperation[]): Set<string> {
  const seen = new Map<string, Set<string>>();
  for (const operation of operations) {
    const key = targetKey(operation);
    const kinds = seen.get(key) ?? new Set<string>();
    kinds.add(operation.op);
    seen.set(key, kinds);
  }
  const conflicting = new Set<string>();
  for (const [key, kinds] of seen) {
    const mutating = [...kinds].filter((kind) => kind !== 'assign' && kind !== 'deassign');
    if (kinds.has('reschedule_event') && kinds.size > 1) conflicting.add(key);
    else if (mutating.length > 1) conflicting.add(key);
    else if (kinds.has('assign') && kinds.has('deassign')) conflicting.add(key);
  }
  return conflicting;
}
