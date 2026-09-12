import { and, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  TRIP_LIMITS,
  eventMutationResponse,
  deleteEventResponse,
  listDeletedEventsResponse,
  type CreateEventRequest,
  type DeleteEventResponse,
  type EventMutationResponse,
  type ListDeletedEventsResponse,
  type PatchEventRequest,
  type PlaceInput,
} from '@trip/contracts';
import { attendance, event, place, tombstone, type Database } from '@trip/db';
import { AppError, notFound } from './errors.js';
import {
  assertExpectedVersion,
  bumpCalendarVersion,
  lockTripAndRequireMembership,
} from './membership.js';
import { assertTripDate, eventInstants } from './instants.js';
import { maxSimultaneous } from './derive.js';
import { runIdempotent } from './receipts.js';
import {
  toAttendanceResource,
  toDeletedEventResource,
  toEventResource,
  toPlaceResource,
} from './serializers.js';
import { deleteZeroAttendanceEvents, readTripState, reconcileWarnings } from './state.js';
import { enumerateTripDates } from './tripDates.js';
import type { Executor, Tx } from './types.js';

export interface EventServiceDeps {
  db: Database;
}

type EventRow = typeof event.$inferSelect;

/** Normalized for duplicate and tombstone matching. Never shown to anyone. */
function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Creates an event and opts its author in.
 *
 * Manual creation pins the schedule against later extraction, which is what
 * stops the model rescheduling something a person deliberately placed.
 */
export async function createEvent(
  deps: EventServiceDeps,
  authUserId: string,
  tripId: string,
  body: CreateEventRequest,
): Promise<EventMutationResponse> {
  const { result } = await runIdempotent(
    deps.db,
    {
      authUserId,
      tripId,
      command: 'event.create',
      idempotencyKey: body.idempotency_key,
      payload: body,
    },
    async (tx) => {
      const { trip: tripRow, self } = await lockTripAndRequireMembership(tx, tripId, authUserId);
      assertExpectedVersion(tripRow, body.expected_calendar_version);

      const dates = enumerateTripDates(tripRow.startDate, tripRow.endDate);
      assertTripDate(dates, body.local_date);
      const { startsAt, endsAt } = eventInstants(
        body.local_date,
        body.start_minute,
        body.end_minute,
        tripRow.timezone,
      );

      await assertLiveEventCapacity(tx, tripId);
      const placeId = await resolvePlace(tx, tripId, body.place);

      const inserted = await tx
        .insert(event)
        .values({
          tripId,
          placeId,
          label: body.label,
          normalizedLabel: normalizeLabel(body.label),
          localDate: body.local_date,
          startMinute: body.start_minute,
          endMinute: body.end_minute,
          startsAt,
          endsAt,
          priceCents: body.price_cents,
          priceSource: body.price_source,
          createdBy: 'human',
          createdByPersonId: self.id,
          scheduleLockedByHuman: true,
          revision: 1n,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) throw new AppError('INTERNAL', 'event insert returned nothing');

      await assertOverlapRoom(tx, tripId, row);

      // Creating an event opts its author in; nobody else is committed by it.
      await tx.insert(attendance).values({
        tripId,
        eventId: row.id,
        personId: self.id,
        state: 'in',
        setBy: 'human',
      });

      return finalize(tx, tripId, self.id, row.id);
    },
    (stored) => eventMutationResponse.parse(stored),
  );
  return result;
}

/**
 * Edits shared details. There is no roster field here: attendance is self-only
 * and has its own command.
 */
export async function patchEvent(
  deps: EventServiceDeps,
  authUserId: string,
  tripId: string,
  eventId: string,
  body: PatchEventRequest,
): Promise<EventMutationResponse> {
  const { result } = await runIdempotent(
    deps.db,
    {
      authUserId,
      tripId,
      command: 'event.patch',
      idempotencyKey: body.idempotency_key,
      payload: { eventId, ...body },
    },
    async (tx) => {
      const { trip: tripRow, self } = await lockTripAndRequireMembership(tx, tripId, authUserId);
      assertExpectedVersion(tripRow, body.expected_calendar_version);

      const current = await liveEvent(tx, tripId, eventId);
      const localDate = body.local_date ?? current.localDate;
      const startMinute = body.start_minute ?? current.startMinute;
      const endMinute = body.end_minute ?? current.endMinute;

      const dates = enumerateTripDates(tripRow.startDate, tripRow.endDate);
      assertTripDate(dates, localDate);
      const { startsAt, endsAt } = eventInstants(
        localDate,
        startMinute,
        endMinute,
        tripRow.timezone,
      );

      const timeChanged =
        localDate !== current.localDate ||
        startMinute !== current.startMinute ||
        endMinute !== current.endMinute;

      const placeId =
        body.place === undefined ? current.placeId : await resolvePlace(tx, tripId, body.place);

      const updated = await tx
        .update(event)
        .set({
          label: body.label ?? current.label,
          normalizedLabel: normalizeLabel(body.label ?? current.label),
          localDate,
          startMinute,
          endMinute,
          startsAt,
          endsAt,
          placeId,
          ...('price_cents' in body
            ? { priceCents: body.price_cents ?? null, priceSource: body.price_source ?? null }
            : {}),
          // A human time edit pins the schedule from here on.
          scheduleLockedByHuman: current.scheduleLockedByHuman || timeChanged,
          revision: sql`${event.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(event.tripId, tripId), eq(event.id, eventId)))
        .returning();
      const row = updated[0];
      if (row === undefined) throw notFound('Event');

      await assertOverlapRoom(tx, tripId, row);
      return finalize(tx, tripId, self.id, row.id);
    },
    (stored) => eventMutationResponse.parse(stored),
  );
  return result;
}

/** Human deletion. Writes a tombstone, which blocks silent recreation. */
export async function deleteEvent(
  deps: EventServiceDeps,
  authUserId: string,
  tripId: string,
  eventId: string,
  body: { idempotency_key: string; expected_calendar_version: string },
): Promise<DeleteEventResponse> {
  const { result } = await runIdempotent(
    deps.db,
    {
      authUserId,
      tripId,
      command: 'event.delete',
      idempotencyKey: body.idempotency_key,
      payload: { eventId, ...body },
    },
    async (tx) => {
      const { trip: tripRow, self } = await lockTripAndRequireMembership(tx, tripId, authUserId);
      assertExpectedVersion(tripRow, body.expected_calendar_version);
      const current = await liveEvent(tx, tripId, eventId);

      const deleted = await tx
        .update(event)
        .set({
          deletedAt: new Date(),
          deletedReason: 'human',
          deletedByPersonId: self.id,
          revision: sql`${event.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(event.tripId, tripId), eq(event.id, eventId)))
        .returning();
      const row = deleted[0];
      if (row === undefined) throw notFound('Event');

      const stone = await tx
        .insert(tombstone)
        .values({
          tripId,
          eventId: row.id,
          occurrenceDate: row.localDate,
          placeId: row.placeId,
          originalLabel: row.label,
          normalizedLabels: [row.normalizedLabel],
          deletedByPersonId: self.id,
        })
        .returning();

      const version = await afterEffects(tx, tripId, self.id);
      return {
        calendar_version: version.toString(),
        deleted: toDeletedEventResource({ ...row, label: current.label }, stone[0]),
      } satisfies DeleteEventResponse;
    },
    (stored) => deleteEventResponse.parse(stored),
  );
  return result;
}

/**
 * Manual restore of a deleted event under its original id, so references to it
 * from chat still resolve. The restorer is opted in; other rosters are not
 * resurrected on their behalf.
 */
export async function restoreEvent(
  deps: EventServiceDeps,
  authUserId: string,
  tripId: string,
  eventId: string,
  body: { idempotency_key: string; expected_calendar_version: string },
): Promise<EventMutationResponse> {
  const { result } = await runIdempotent(
    deps.db,
    {
      authUserId,
      tripId,
      command: 'event.restore',
      idempotencyKey: body.idempotency_key,
      payload: { eventId, ...body },
    },
    async (tx) => {
      const { trip: tripRow, self } = await lockTripAndRequireMembership(tx, tripId, authUserId);
      assertExpectedVersion(tripRow, body.expected_calendar_version);

      const rows = await tx
        .select()
        .from(event)
        .where(and(eq(event.tripId, tripId), eq(event.id, eventId), isNotNull(event.deletedAt)))
        .limit(1);
      const current = rows[0];
      if (current === undefined) throw notFound('Deleted event');

      await assertLiveEventCapacity(tx, tripId);

      const restored = await tx
        .update(event)
        .set({
          deletedAt: null,
          deletedReason: null,
          deletedByPersonId: null,
          scheduleLockedByHuman: true,
          revision: sql`${event.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(event.tripId, tripId), eq(event.id, eventId)))
        .returning();
      const row = restored[0];
      if (row === undefined) throw notFound('Deleted event');

      await assertOverlapRoom(tx, tripId, row);

      await tx
        .insert(attendance)
        .values({ tripId, eventId: row.id, personId: self.id, state: 'in', setBy: 'human' })
        .onConflictDoUpdate({
          target: [attendance.eventId, attendance.personId],
          set: { state: 'in', setBy: 'human', updatedAt: new Date() },
        });

      // The tombstone is cleared logically: the visit is back on.
      await tx
        .update(tombstone)
        .set({ clearedAt: new Date() })
        .where(
          and(
            eq(tombstone.tripId, tripId),
            eq(tombstone.eventId, eventId),
            isNull(tombstone.clearedAt),
          ),
        );

      return finalize(tx, tripId, self.id, row.id);
    },
    (stored) => eventMutationResponse.parse(stored),
  );
  return result;
}

/** Paginated removal history, newest first. */
export async function listDeletedEvents(
  exec: Executor,
  tripId: string,
  query: { cursor?: string; limit: number },
): Promise<ListDeletedEventsResponse> {
  const cursorDate = query.cursor === undefined ? null : new Date(query.cursor);
  if (cursorDate !== null && Number.isNaN(cursorDate.getTime())) {
    throw new AppError('BAD_REQUEST', 'cursor is not a timestamp');
  }

  const rows = await exec
    .select()
    .from(event)
    .where(
      and(
        eq(event.tripId, tripId),
        isNotNull(event.deletedAt),
        cursorDate === null ? undefined : lt(event.deletedAt, cursorDate),
      ),
    )
    .orderBy(desc(event.deletedAt))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const stones = await tombstonesFor(
    exec,
    tripId,
    page.map((row) => row.id),
  );
  const last = page[page.length - 1];

  return listDeletedEventsResponse.parse({
    items: page.map((row) => toDeletedEventResource(row, stones.get(row.id))),
    next_cursor: rows.length > query.limit && last?.deletedAt ? last.deletedAt.toISOString() : null,
    has_more: rows.length > query.limit,
  });
}

export async function tombstonesFor(
  exec: Executor,
  tripId: string,
  eventIds: string[],
): Promise<Map<string, typeof tombstone.$inferSelect>> {
  if (eventIds.length === 0) return new Map();
  const rows = await exec
    .select()
    .from(tombstone)
    .where(and(eq(tombstone.tripId, tripId), isNull(tombstone.clearedAt)));
  return new Map(
    rows.filter((row) => eventIds.includes(row.eventId)).map((row) => [row.eventId, row]),
  );
}

/* -------------------------------------------------------------------------- */

async function liveEvent(tx: Tx, tripId: string, eventId: string): Promise<EventRow> {
  const rows = await tx
    .select()
    .from(event)
    .where(and(eq(event.tripId, tripId), eq(event.id, eventId), isNull(event.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw notFound('Event');
  return row;
}

async function assertLiveEventCapacity(tx: Tx, tripId: string): Promise<void> {
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(event)
    .where(and(eq(event.tripId, tripId), isNull(event.deletedAt)));
  if ((rows[0]?.count ?? 0) >= TRIP_LIMITS.maxLiveEvents) {
    throw new AppError(
      'CAPACITY_EXCEEDED',
      `A trip holds at most ${TRIP_LIMITS.maxLiveEvents} events`,
    );
  }
}

/**
 * At most three events may run at once, across the whole trip. Checked after
 * the write inside the trip lock, so two concurrent creates cannot both pass a
 * read taken before either committed.
 */
async function assertOverlapRoom(tx: Tx, tripId: string, candidate: EventRow): Promise<void> {
  const state = await readTripState(tx, tripId);
  const resource = toEventResource(candidate);
  if (maxSimultaneous(state.events, resource) > TRIP_LIMITS.maxOverlappingEvents) {
    throw new AppError(
      'CAPACITY_EXCEEDED',
      `At most ${TRIP_LIMITS.maxOverlappingEvents} events may run at the same time`,
    );
  }
}

/**
 * A place named by a manual command. There is no provider here in M1, so a
 * candidate reference has nothing to replay and is refused rather than faked.
 */
async function resolvePlace(
  tx: Tx,
  tripId: string,
  input: PlaceInput | null | undefined,
): Promise<string | null> {
  if (input === null || input === undefined) return null;

  if (input.kind === 'existing') {
    const rows = await tx
      .select({ id: place.id })
      .from(place)
      .where(and(eq(place.tripId, tripId), eq(place.id, input.place_id)))
      .limit(1);
    if (rows[0] === undefined) throw notFound('Place');
    return rows[0].id;
  }

  if (input.kind === 'candidate') {
    throw new AppError(
      'DEPENDENCY_UNAVAILABLE',
      'Place search is not enabled, so there is no candidate to select',
    );
  }

  // A venue named only in words has nothing resolved yet. It is stored as
  // pending with its query, for M3 enrichment to pick up, and reads as an
  // unresolved stop until then rather than as a located one.
  const values =
    input.kind === 'query'
      ? {
          tripId,
          label: input.query,
          normalizedLabel: normalizeLabel(input.query),
          searchQuery: input.query,
          resolution: 'pending' as const,
          humanOverride: false,
          revision: 1n,
        }
      : {
          tripId,
          label: input.label,
          normalizedLabel: normalizeLabel(input.label),
          address: input.address ?? null,
          lat: input.coordinate?.lat ?? null,
          lon: input.coordinate?.lon ?? null,
          // A person typed this, so it is never overwritten automatically.
          resolution: 'manual' as const,
          humanOverride: true,
          revision: 1n,
        };

  const inserted = await tx.insert(place).values(values).returning({ id: place.id });
  const row = inserted[0];
  if (row === undefined) throw new AppError('INTERNAL', 'place insert returned nothing');
  return row.id;
}

/** Final-state cleanup, version bump and warning reconciliation, in that order. */
async function afterEffects(tx: Tx, tripId: string, byPersonId: string): Promise<bigint> {
  await deleteZeroAttendanceEvents(tx, tripId, byPersonId);
  const version = await bumpCalendarVersion(tx, tripId);
  const state = await readTripState(tx, tripId);
  await reconcileWarnings(tx, tripId, state, version);
  return version;
}

async function finalize(
  tx: Tx,
  tripId: string,
  byPersonId: string,
  eventId: string,
): Promise<EventMutationResponse> {
  const version = await afterEffects(tx, tripId, byPersonId);

  const rows = await tx
    .select()
    .from(event)
    .where(and(eq(event.tripId, tripId), eq(event.id, eventId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw notFound('Event');

  const attendanceRows = await tx
    .select()
    .from(attendance)
    .where(and(eq(attendance.tripId, tripId), eq(attendance.eventId, eventId)));

  const placeRows =
    row.placeId === null
      ? []
      : await tx
          .select()
          .from(place)
          .where(and(eq(place.tripId, tripId), eq(place.id, row.placeId)))
          .limit(1);

  return {
    calendar_version: version.toString(),
    event: toEventResource(row),
    attendance: attendanceRows.map(toAttendanceResource),
    place: placeRows[0] === undefined ? null : toPlaceResource(placeRows[0]),
  } satisfies EventMutationResponse;
}
