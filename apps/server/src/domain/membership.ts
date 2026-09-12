import { and, eq, sql } from 'drizzle-orm';
import { person, trip } from '@trip/db';
import { AppError, notFound, staleVersion } from './errors.js';
import type { Executor, Tx } from './types.js';

export type TripRow = typeof trip.$inferSelect;
export type PersonRow = typeof person.$inferSelect;

export interface Membership {
  trip: TripRow;
  self: PersonRow;
}

/**
 * Locks the trip row, then resolves the caller's membership.
 *
 * Lock order is always trip first, then children in stable id order. Every
 * writer in this system takes the trip lock before allocating a message id or
 * touching any child row, which is what makes committed message order match id
 * order and what serialises the per-trip invariants.
 */
export async function lockTripAndRequireMembership(
  tx: Tx,
  tripId: string,
  authUserId: string,
): Promise<Membership> {
  const tripRows = await tx.select().from(trip).where(eq(trip.id, tripId)).for('update').limit(1);
  const tripRow = tripRows[0];
  if (tripRow === undefined) throw notFound('Trip');

  const self = await findMembership(tx, tripId, authUserId);
  if (self === undefined) throw notFound('Trip');

  return { trip: tripRow, self };
}

/** Read-only membership resolution. Does not lock. */
export async function requireMembership(
  exec: Executor,
  tripId: string,
  authUserId: string,
): Promise<Membership> {
  const tripRows = await exec.select().from(trip).where(eq(trip.id, tripId)).limit(1);
  const tripRow = tripRows[0];
  if (tripRow === undefined) throw notFound('Trip');

  const self = await findMembership(exec, tripId, authUserId);
  // A nonmember is told the trip does not exist rather than that it does.
  if (self === undefined) throw notFound('Trip');

  return { trip: tripRow, self };
}

/**
 * Membership id of the trip creator. Rotation of invite links is creator-only,
 * so the client needs this to render the right affordance; the underlying auth
 * user id stays private.
 */
export async function creatorPersonId(exec: Executor, tripRow: TripRow): Promise<string> {
  const creator = await findMembership(exec, tripRow.id, tripRow.creatorAuthUserId);
  if (creator === undefined) {
    throw new AppError('INTERNAL', 'trip has no creator membership');
  }
  return creator.id;
}

export async function findMembership(
  exec: Executor,
  tripId: string,
  authUserId: string,
): Promise<PersonRow | undefined> {
  const rows = await exec
    .select()
    .from(person)
    .where(and(eq(person.tripId, tripId), eq(person.authUserId, authUserId)))
    .limit(1);
  return rows[0];
}

/**
 * Human domain edits must name the version they believed they were editing.
 * A mismatch is reported with the current version so the client can reconcile
 * without discarding the user's draft.
 */
export function assertExpectedVersion(tripRow: TripRow, expected: string): void {
  if (tripRow.calendarVersion.toString() !== expected) {
    throw staleVersion(tripRow.calendarVersion);
  }
}

/**
 * Bumps the calendar version once for a material domain change. Chat inserts
 * and processing-status changes deliberately do not call this.
 */
export async function bumpCalendarVersion(tx: Tx, tripId: string): Promise<bigint> {
  const rows = await tx
    .update(trip)
    .set({ calendarVersion: sql`${trip.calendarVersion} + 1`, updatedAt: new Date() })
    .where(eq(trip.id, tripId))
    .returning({ calendarVersion: trip.calendarVersion });
  const row = rows[0];
  if (row === undefined) throw new AppError('INTERNAL', 'trip disappeared during mutation');
  return row.calendarVersion;
}
