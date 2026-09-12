import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  attendanceMutationResponse,
  placeMutationResponse,
  type AttendanceMutationResponse,
  type PatchPlaceRequest,
  type PlaceMutationResponse,
  type PutSelfAttendanceRequest,
} from '@trip/contracts';
import { attendance, event, place, type Database } from '@trip/db';
import { AppError, notFound } from './errors.js';
import {
  assertExpectedVersion,
  bumpCalendarVersion,
  lockTripAndRequireMembership,
} from './membership.js';
import { runIdempotent } from './receipts.js';
import { toAttendanceResource, toEventResource, toPlaceResource } from './serializers.js';
import { deleteZeroAttendanceEvents, readTripState, reconcileWarnings } from './state.js';

export interface AttendanceServiceDeps {
  db: Database;
}

/**
 * Your own attendance, and only your own.
 *
 * There is no person id in the request: self comes from the verified session,
 * so there is no shape in which one member can commit another. "Undecided" is
 * the absence of a row rather than a third stored state.
 */
export async function putSelfAttendance(
  deps: AttendanceServiceDeps,
  authUserId: string,
  tripId: string,
  eventId: string,
  body: PutSelfAttendanceRequest,
): Promise<AttendanceMutationResponse> {
  const { result } = await runIdempotent(
    deps.db,
    {
      authUserId,
      tripId,
      command: 'attendance.put',
      idempotencyKey: body.idempotency_key,
      payload: { eventId, ...body },
    },
    async (tx) => {
      const { trip: tripRow, self } = await lockTripAndRequireMembership(tx, tripId, authUserId);
      assertExpectedVersion(tripRow, body.expected_calendar_version);

      const rows = await tx
        .select()
        .from(event)
        .where(and(eq(event.tripId, tripId), eq(event.id, eventId), isNull(event.deletedAt)))
        .limit(1);
      if (rows[0] === undefined) throw notFound('Event');

      if (body.state === 'undecided') {
        await tx
          .delete(attendance)
          .where(and(eq(attendance.eventId, eventId), eq(attendance.personId, self.id)));
      } else {
        await tx
          .insert(attendance)
          .values({
            tripId,
            eventId,
            personId: self.id,
            state: body.state,
            setBy: 'human',
          })
          .onConflictDoUpdate({
            target: [attendance.eventId, attendance.personId],
            set: { state: body.state, setBy: 'human', updatedAt: new Date() },
          });
      }

      // Attendance is part of the event's identity for Undo purposes, so it
      // advances the event revision too.
      await tx
        .update(event)
        .set({ revision: sql`${event.revision} + 1`, updatedAt: new Date() })
        .where(and(eq(event.tripId, tripId), eq(event.id, eventId)));

      const removed = await deleteZeroAttendanceEvents(tx, tripId, self.id);
      const version = await bumpCalendarVersion(tx, tripId);
      const state = await readTripState(tx, tripId);
      await reconcileWarnings(tx, tripId, state, version);

      // An event that just lost its last attendee is gone, and saying so is
      // more honest than returning a row the calendar will not show.
      if (removed.includes(eventId)) {
        return {
          calendar_version: version.toString(),
          event: null,
          attendance: [],
        } satisfies AttendanceMutationResponse;
      }

      const after = await tx
        .select()
        .from(event)
        .where(and(eq(event.tripId, tripId), eq(event.id, eventId)))
        .limit(1);
      const attendanceRows = await tx
        .select()
        .from(attendance)
        .where(and(eq(attendance.tripId, tripId), eq(attendance.eventId, eventId)));

      return {
        calendar_version: version.toString(),
        event: after[0] === undefined ? null : toEventResource(after[0]),
        attendance: attendanceRows.map(toAttendanceResource),
      } satisfies AttendanceMutationResponse;
    },
    (stored) => attendanceMutationResponse.parse(stored),
  );
  return result;
}

/**
 * Manual venue correction: where a place is, and when it is open on an exact
 * trip date. A human correction sets `human_override`, which enrichment in M3
 * must never overwrite.
 */
export async function patchPlace(
  deps: AttendanceServiceDeps,
  authUserId: string,
  tripId: string,
  placeId: string,
  body: PatchPlaceRequest,
): Promise<PlaceMutationResponse> {
  const { result } = await runIdempotent(
    deps.db,
    {
      authUserId,
      tripId,
      command: 'place.patch',
      idempotencyKey: body.idempotency_key,
      payload: { placeId, ...body },
    },
    async (tx) => {
      // Membership is required to correct shared venue data; which member it
      // is does not change the outcome, so the row is not needed here.
      const { trip: tripRow } = await lockTripAndRequireMembership(tx, tripId, authUserId);
      assertExpectedVersion(tripRow, body.expected_calendar_version);

      if (body.choice.kind === 'candidate') {
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          'Place search is not enabled, so there is no candidate to select',
        );
      }
      const choice = body.choice;

      const current = await tx
        .select()
        .from(place)
        .where(and(eq(place.tripId, tripId), eq(place.id, placeId)))
        .limit(1);
      const row = current[0];
      if (row === undefined) throw notFound('Place');

      const hoursGiven = choice.hours_days !== undefined;
      const updated = await tx
        .update(place)
        .set({
          label: choice.label ?? row.label,
          address: choice.address === undefined ? row.address : choice.address,
          ...(choice.coordinate === undefined
            ? {}
            : { lat: choice.coordinate?.lat ?? null, lon: choice.coordinate?.lon ?? null }),
          ...(hoursGiven
            ? {
                hoursDays: choice.hours_days,
                hoursProvenance: 'human' as const,
                hoursObservedAt: new Date(),
              }
            : {}),
          resolution: 'manual',
          humanOverride: true,
          revision: sql`${place.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(place.tripId, tripId), eq(place.id, placeId)))
        .returning();
      const after = updated[0];
      if (after === undefined) throw notFound('Place');

      // Shared place metadata advances the calendar version, and the hours or
      // coordinates may have just raised or cleared a warning.
      const version = await bumpCalendarVersion(tx, tripId);
      const state = await readTripState(tx, tripId);
      await reconcileWarnings(tx, tripId, state, version);

      return {
        calendar_version: version.toString(),
        place: toPlaceResource(after),
      } satisfies PlaceMutationResponse;
    },
    (stored) => placeMutationResponse.parse(stored),
  );
  return result;
}
