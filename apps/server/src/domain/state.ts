import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { WarningResource } from '@trip/contracts';
import { attendance, event, person, place, warning } from '@trip/db';
import { deriveWarnings, type DerivedInput } from './derive.js';
import {
  toAttendanceResource,
  toEventResource,
  toPersonResource,
  toPlaceResource,
} from './serializers.js';
import type { Executor, Tx } from './types.js';

/**
 * The live state of one trip, as resources.
 *
 * Read inside the caller's transaction so commands and the snapshot derive
 * their answers from the same committed instant. Deleted events are excluded:
 * nothing derived counts them.
 */
export async function readTripState(exec: Executor, tripId: string): Promise<DerivedInput> {
  // Sequential on purpose: a transaction is one connection, and issuing these
  // concurrently would pipeline queries onto a client already executing one.
  const memberRows = await exec
    .select()
    .from(person)
    .where(eq(person.tripId, tripId))
    .orderBy(person.colorIndex);
  const eventRows = await exec
    .select()
    .from(event)
    .where(and(eq(event.tripId, tripId), isNull(event.deletedAt)));
  const placeRows = await exec.select().from(place).where(eq(place.tripId, tripId));

  const liveIds = eventRows.map((row) => row.id);
  const attendanceRows =
    liveIds.length === 0
      ? []
      : await exec
          .select()
          .from(attendance)
          .where(and(eq(attendance.tripId, tripId), inArray(attendance.eventId, liveIds)));

  return {
    members: memberRows.map(toPersonResource),
    events: eventRows.map(toEventResource),
    attendance: attendanceRows.map(toAttendanceResource),
    places: placeRows.map(toPlaceResource),
  };
}

/**
 * Deletes any live event nobody is attending any more.
 *
 * Applied to the command's final state rather than after each individual
 * change, so moving the last attendee from one event to another does not
 * delete something the same command was about to repopulate. These deletions
 * get no tombstone: nothing was decided against, so nothing should block the
 * visit being planned again.
 */
export async function deleteZeroAttendanceEvents(
  tx: Tx,
  tripId: string,
  byPersonId: string | null,
): Promise<string[]> {
  const orphans = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.tripId, tripId),
        isNull(event.deletedAt),
        sql`not exists (
          select 1 from attendance a
          where a.event_id = ${event.id} and a.state = 'in'
        )`,
      ),
    );
  if (orphans.length === 0) return [];

  const ids = orphans.map((row) => row.id);
  await tx
    .update(event)
    .set({
      deletedAt: new Date(),
      deletedReason: 'auto_zero_attendance',
      deletedByPersonId: byPersonId,
      revision: sql`${event.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(event.tripId, tripId), inArray(event.id, ids)));
  return ids;
}

/**
 * Reconciles stored warnings with what the new state justifies.
 *
 * Transitions are deduplicated: a warning that was already active keeps its
 * original `activated_at_version` instead of being re-raised, and one that no
 * longer holds is resolved at this version rather than deleted, so the history
 * of what the planner noticed survives.
 */
export async function reconcileWarnings(
  tx: Tx,
  tripId: string,
  state: DerivedInput,
  atVersion: bigint,
): Promise<void> {
  const expected = deriveWarnings(state, atVersion.toString());
  const expectedByKey = new Map(expected.map((row) => [row.key, row]));

  const stored = await tx.select().from(warning).where(eq(warning.tripId, tripId));
  const storedByKey = new Map(stored.map((row) => [row.key, row]));

  for (const [key, row] of expectedByKey) {
    const existing = storedByKey.get(key);
    if (existing === undefined) {
      await tx.insert(warning).values({
        tripId,
        key,
        kind: row.kind,
        personId: row.person_id,
        eventIds: row.event_ids,
        details: row.details,
        active: true,
        activatedAtVersion: atVersion,
        resolvedAtVersion: null,
      });
      continue;
    }
    if (existing.active && sameDetails(existing.details, row.details)) continue;

    await tx
      .update(warning)
      .set({
        details: row.details,
        eventIds: row.event_ids,
        active: true,
        // Reactivation is a new occurrence; an unchanged active one is untouched.
        activatedAtVersion: existing.active ? existing.activatedAtVersion : atVersion,
        resolvedAtVersion: null,
        updatedAt: new Date(),
      })
      .where(and(eq(warning.tripId, tripId), eq(warning.key, key)));
  }

  const goneKeys = stored
    .filter((row) => row.active && !expectedByKey.has(row.key))
    .map((row) => row.key);
  if (goneKeys.length > 0) {
    await tx
      .update(warning)
      .set({ active: false, resolvedAtVersion: atVersion, updatedAt: new Date() })
      .where(and(eq(warning.tripId, tripId), inArray(warning.key, goneKeys)));
  }
}

function sameDetails(stored: unknown, next: unknown): boolean {
  return JSON.stringify(stored) === JSON.stringify(next);
}

export async function readWarnings(exec: Executor, tripId: string): Promise<WarningResource[]> {
  const rows = await exec.select().from(warning).where(eq(warning.tripId, tripId));
  return rows.map(
    (row) =>
      ({
        kind: row.kind,
        key: row.key,
        person_id: row.personId,
        event_ids: row.eventIds,
        active: row.active,
        activated_at_version: row.activatedAtVersion.toString(),
        resolved_at_version:
          row.resolvedAtVersion === null ? null : row.resolvedAtVersion.toString(),
        details: row.details,
      }) as WarningResource,
  );
}
