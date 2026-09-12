import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  createTripResponse,
  personMutationResponse,
  tripMutationResponse,
  createInviteResponse,
  TRIP_LIMITS,
  PERSON_COLORS,
  type CreateInviteResponse,
  type CreateTripRequest,
  type CreateTripResponse,
  type InvitePreviewResponse,
  type JoinTripRequest,
  type JoinTripResponse,
  type PatchSelfPersonRequest,
  type PatchTripRequest,
  type PersonMutationResponse,
  type TripMutationResponse,
} from '@trip/contracts';
import { message, person, placeCandidate, trip, tripInvite, type Database } from '@trip/db';
import { AppError, notFound } from './errors.js';
import { generateInviteToken, sha256 } from './hash.js';
import {
  assertExpectedVersion,
  bumpCalendarVersion,
  creatorPersonId,
  findMembership,
  lockTripAndRequireMembership,
} from './membership.js';
import { runIdempotent } from './receipts.js';
import { toPersonResource, toTripResource } from './serializers.js';
import { enumerateTripDates } from './tripDates.js';
import type { Tx } from './types.js';

export interface TripServiceDeps {
  db: Database;
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

export async function createTrip(
  deps: TripServiceDeps,
  authUserId: string,
  body: CreateTripRequest,
): Promise<CreateTripResponse> {
  const dates = enumerateTripDates(body.start_date, body.end_date);

  // Minted before the transaction; only its hash is ever stored.
  const token = generateInviteToken();

  const { result } = await runIdempotent(
    deps.db,
    {
      authUserId,
      tripId: null,
      command: 'create_trip',
      idempotencyKey: body.idempotency_key,
      payload: stripIdempotencyKey(body),
    },
    async (tx) => {
      const destination = await resolveDestination(tx, authUserId, body.destination);

      const tripRows = await tx
        .insert(trip)
        .values({
          tripName: body.trip_name,
          groupName: body.group_name,
          expectedHeadcount: body.expected_headcount,
          destinationLabel: destination.label,
          destinationLat: destination.lat,
          destinationLon: destination.lon,
          timezone: destination.timezone,
          startDate: dates[0] as string,
          endDate: dates[dates.length - 1] as string,
          creatorAuthUserId: authUserId,
        })
        .returning();
      const tripRow = tripRows[0];
      if (tripRow === undefined) throw new AppError('INTERNAL', 'trip insert returned no row');

      const personRows = await tx
        .insert(person)
        .values({
          tripId: tripRow.id,
          authUserId,
          displayName: body.self_display_name,
          // The creator always takes the first palette slot.
          colorIndex: 0,
          budgetCents: body.self_budget_cents,
        })
        .returning();
      const personRow = personRows[0];
      if (personRow === undefined) throw new AppError('INTERNAL', 'person insert returned no row');

      await tx.insert(tripInvite).values({
        tripId: tripRow.id,
        tokenHash: sha256(token),
        createdByPersonId: personRow.id,
      });

      const response: CreateTripResponse = {
        trip: toTripResource(tripRow, personRow.id),
        self: toPersonResource(personRow),
        members: [toPersonResource(personRow)],
        invite: { token, expires_at: null },
        calendar_version: tripRow.calendarVersion.toString(),
      };
      return response;
    },
    (stored) => createTripResponse.parse(stored),
  );

  return result;
}

interface ResolvedDestination {
  label: string;
  lat: number;
  lon: number;
  timezone: string;
}

/**
 * Resolves the wizard's destination. A client may replay a server-issued search
 * candidate or supply explicit manual values; it can never hand over a trusted
 * provider record of its own construction.
 */
async function resolveDestination(
  tx: Tx,
  authUserId: string,
  input: CreateTripRequest['destination'],
): Promise<ResolvedDestination> {
  if (input.kind === 'manual') {
    return {
      label: input.label,
      lat: input.center.lat,
      lon: input.center.lon,
      timezone: input.timezone,
    };
  }

  const rows = await tx
    .select()
    .from(placeCandidate)
    .where(eq(placeCandidate.id, input.candidate_ref))
    .limit(1);
  const candidate = rows[0];

  if (
    candidate === undefined ||
    candidate.authUserId !== authUserId ||
    candidate.expiresAt.getTime() <= Date.now()
  ) {
    throw new AppError('UNPROCESSABLE', 'That place selection expired; search again', {
      fieldErrors: [{ path: 'destination.candidate_ref', message: 'expired or unknown' }],
    });
  }
  if (candidate.lat === null || candidate.lon === null) {
    throw new AppError('UNPROCESSABLE', 'That place has no coordinates; enter them manually');
  }

  const timezone = input.timezone ?? candidate.timezone;
  if (timezone === null || timezone === undefined) {
    throw new AppError('UNPROCESSABLE', 'A timezone is required for this destination', {
      fieldErrors: [{ path: 'destination.timezone', message: 'required for this destination' }],
    });
  }

  return { label: candidate.label, lat: candidate.lat, lon: candidate.lon, timezone };
}

/* -------------------------------------------------------------------------- */
/* Invites                                                                     */
/* -------------------------------------------------------------------------- */

export async function previewInvite(
  deps: TripServiceDeps,
  token: string,
): Promise<InvitePreviewResponse> {
  const rows = await deps.db
    .select({ invite: tripInvite, trip })
    .from(tripInvite)
    .innerJoin(trip, eq(trip.id, tripInvite.tripId))
    .where(eq(tripInvite.tokenHash, sha256(token)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw notFound('Invite');

  const memberCount = await countMembers(deps.db, row.trip.id);
  const unavailable = inviteUnavailableReason(row.invite, memberCount);

  // Deliberately minimal: an invite holder is not a member and must not learn
  // who is in the trip, what is planned, or what anyone budgeted.
  return {
    trip_name: row.trip.tripName,
    group_name: row.trip.groupName,
    destination_label: row.trip.destinationLabel,
    start_date: row.trip.startDate,
    end_date: row.trip.endDate,
    join_available: unavailable === null,
    unavailable_reason: unavailable,
  };
}

function inviteUnavailableReason(
  invite: typeof tripInvite.$inferSelect,
  memberCount: number,
): 'trip_full' | 'revoked' | 'expired' | null {
  if (invite.revokedAt !== null) return 'revoked';
  if (invite.expiresAt !== null && invite.expiresAt.getTime() <= Date.now()) return 'expired';
  if (memberCount >= TRIP_LIMITS.maxMembers) return 'trip_full';
  return null;
}

export async function joinTrip(
  deps: TripServiceDeps,
  authUserId: string,
  body: JoinTripRequest,
): Promise<JoinTripResponse> {
  const tokenHash = sha256(body.token);

  // Resolve the trip id outside the lock so the lock order stays trip-first.
  const located = await deps.db
    .select({ tripId: tripInvite.tripId })
    .from(tripInvite)
    .where(eq(tripInvite.tokenHash, tokenHash))
    .limit(1);
  const target = located[0];
  if (target === undefined) throw notFound('Invite');

  return deps.db.transaction(async (tx) => {
    const tripRows = await tx
      .select()
      .from(trip)
      .where(eq(trip.id, target.tripId))
      .for('update')
      .limit(1);
    const tripRow = tripRows[0];
    if (tripRow === undefined) throw notFound('Invite');

    const existing = await findMembership(tx, tripRow.id, authUserId);
    if (existing !== undefined) {
      // The same session reopening an invite gets its membership back unchanged.
      const members = await listMembers(tx, tripRow.id);
      return {
        trip: toTripResource(tripRow, await creatorPersonId(tx, tripRow)),
        self: toPersonResource(existing),
        members,
        calendar_version: tripRow.calendarVersion.toString(),
        already_member: true,
      } satisfies JoinTripResponse;
    }

    const inviteRows = await tx
      .select()
      .from(tripInvite)
      .where(and(eq(tripInvite.tripId, tripRow.id), eq(tripInvite.tokenHash, tokenHash)))
      .limit(1);
    const invite = inviteRows[0];
    if (invite === undefined) throw notFound('Invite');

    const existingColors = await tx
      .select({ colorIndex: person.colorIndex })
      .from(person)
      .where(eq(person.tripId, tripRow.id));

    const reason = inviteUnavailableReason(invite, existingColors.length);
    if (reason === 'trip_full') {
      throw new AppError('TRIP_FULL', 'This trip already has the maximum number of members');
    }
    if (reason !== null) {
      throw new AppError('INVITE_UNUSABLE', 'This invite link is no longer usable');
    }

    const colorIndex = firstUnusedColorIndex(existingColors.map((c) => c.colorIndex));

    const personRows = await tx
      .insert(person)
      .values({
        tripId: tripRow.id,
        authUserId,
        displayName: body.display_name,
        colorIndex,
        budgetCents: body.budget_cents,
      })
      .returning();
    const personRow = personRows[0];
    if (personRow === undefined) throw new AppError('INTERNAL', 'person insert returned no row');

    // Audit effect written in the same transaction as the membership itself.
    await tx.insert(message).values({
      tripId: tripRow.id,
      kind: 'system',
      body: `${personRow.displayName} joined the trip`,
      metadata: { type: 'member_joined', person_id: personRow.id },
    });

    const calendarVersion = await bumpCalendarVersion(tx, tripRow.id);
    const members = await listMembers(tx, tripRow.id);

    return {
      trip: toTripResource(tripRow, await creatorPersonId(tx, tripRow)),
      self: toPersonResource(personRow),
      members,
      calendar_version: calendarVersion.toString(),
      already_member: false,
    } satisfies JoinTripResponse;
  });
}

function firstUnusedColorIndex(used: number[]): number {
  const taken = new Set(used);
  for (let index = 0; index < PERSON_COLORS.length; index += 1) {
    if (!taken.has(index)) return index;
  }
  throw new AppError('TRIP_FULL', 'This trip already has the maximum number of members');
}

export async function mintInvite(
  deps: TripServiceDeps,
  authUserId: string,
  tripId: string,
  body: { idempotency_key: string; rotate: boolean },
): Promise<CreateInviteResponse> {
  const token = generateInviteToken();

  const { result } = await runIdempotent(
    deps.db,
    {
      authUserId,
      tripId,
      command: 'create_invite',
      idempotencyKey: body.idempotency_key,
      payload: { trip_id: tripId, rotate: body.rotate },
    },
    async (tx) => {
      const { trip: tripRow, self } = await lockTripAndRequireMembership(tx, tripId, authUserId);

      let revokedPrevious = 0;
      if (body.rotate) {
        // Any member may mint a link; only the creator may invalidate existing ones.
        if (self.authUserId !== tripRow.creatorAuthUserId) {
          throw new AppError('FORBIDDEN', 'Only the trip creator can rotate invite links');
        }
        const revoked = await tx
          .update(tripInvite)
          .set({ revokedAt: new Date() })
          .where(and(eq(tripInvite.tripId, tripId), isNull(tripInvite.revokedAt)))
          .returning({ id: tripInvite.id });
        revokedPrevious = revoked.length;
      }

      await tx.insert(tripInvite).values({
        tripId,
        tokenHash: sha256(token),
        createdByPersonId: self.id,
      });

      return {
        invite: { token, expires_at: null },
        revoked_previous: revokedPrevious,
      } satisfies CreateInviteResponse;
    },
    (stored) => createInviteResponse.parse(stored),
  );

  return result;
}

/* -------------------------------------------------------------------------- */
/* Self-only and shared property edits                                         */
/* -------------------------------------------------------------------------- */

export async function patchSelfPerson(
  deps: TripServiceDeps,
  authUserId: string,
  tripId: string,
  body: PatchSelfPersonRequest,
): Promise<PersonMutationResponse> {
  const { result } = await runIdempotent(
    deps.db,
    {
      authUserId,
      tripId,
      command: 'patch_self_person',
      idempotencyKey: body.idempotency_key,
      payload: stripIdempotencyKey({ ...body, trip_id: tripId }),
    },
    async (tx) => {
      const { trip: tripRow, self } = await lockTripAndRequireMembership(tx, tripId, authUserId);
      assertExpectedVersion(tripRow, body.expected_calendar_version);

      const nextName = body.display_name ?? self.displayName;
      const nextBudget = body.budget_cents ?? self.budgetCents;
      const unchanged = nextName === self.displayName && nextBudget === self.budgetCents;

      if (unchanged) {
        // A no-op produces no duplicate audit entry and no version bump.
        return {
          calendar_version: tripRow.calendarVersion.toString(),
          person: toPersonResource(self),
        } satisfies PersonMutationResponse;
      }

      const updated = await tx
        .update(person)
        // The row is selected by verified auth user, so this can only ever be self.
        .set({ displayName: nextName, budgetCents: nextBudget, updatedAt: new Date() })
        .where(eq(person.id, self.id))
        .returning();
      const personRow = updated[0];
      if (personRow === undefined) throw new AppError('INTERNAL', 'person update returned no row');

      const calendarVersion = await bumpCalendarVersion(tx, tripId);
      return {
        calendar_version: calendarVersion.toString(),
        person: toPersonResource(personRow),
      } satisfies PersonMutationResponse;
    },
    (stored) => personMutationResponse.parse(stored),
  );

  return result;
}

export async function patchTrip(
  deps: TripServiceDeps,
  authUserId: string,
  tripId: string,
  body: PatchTripRequest,
): Promise<TripMutationResponse> {
  const { result } = await runIdempotent(
    deps.db,
    {
      authUserId,
      tripId,
      command: 'patch_trip',
      idempotencyKey: body.idempotency_key,
      payload: stripIdempotencyKey({ ...body, trip_id: tripId }),
    },
    async (tx) => {
      const { trip: tripRow } = await lockTripAndRequireMembership(tx, tripId, authUserId);
      assertExpectedVersion(tripRow, body.expected_calendar_version);

      const nextTripName = body.trip_name ?? tripRow.tripName;
      const nextGroupName = body.group_name ?? tripRow.groupName;
      const creatorId = await creatorPersonId(tx, tripRow);
      if (nextTripName === tripRow.tripName && nextGroupName === tripRow.groupName) {
        return {
          calendar_version: tripRow.calendarVersion.toString(),
          trip: toTripResource(tripRow, creatorId),
        } satisfies TripMutationResponse;
      }

      // Destination, dates, timezone and currency are immutable after creation.
      const updated = await tx
        .update(trip)
        .set({
          tripName: nextTripName,
          groupName: nextGroupName,
          calendarVersion: sql`${trip.calendarVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(trip.id, tripId))
        .returning();
      const updatedRow = updated[0];
      if (updatedRow === undefined) throw new AppError('INTERNAL', 'trip update returned no row');

      return {
        calendar_version: updatedRow.calendarVersion.toString(),
        trip: toTripResource(updatedRow, creatorId),
      } satisfies TripMutationResponse;
    },
    (stored) => tripMutationResponse.parse(stored),
  );

  return result;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

export async function listMembers(
  exec: Tx | Database,
  tripId: string,
): Promise<ReturnType<typeof toPersonResource>[]> {
  const rows = await exec
    .select()
    .from(person)
    .where(eq(person.tripId, tripId))
    .orderBy(asc(person.colorIndex));
  return rows.map(toPersonResource);
}

async function countMembers(db: Database, tripId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(person)
    .where(eq(person.tripId, tripId));
  return rows[0]?.count ?? 0;
}

function stripIdempotencyKey<T extends { idempotency_key?: unknown }>(
  value: T,
): Omit<T, 'idempotency_key'> {
  const { idempotency_key: _ignored, ...rest } = value;
  return rest;
}
