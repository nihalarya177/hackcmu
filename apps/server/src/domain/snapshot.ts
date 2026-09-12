import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import {
  PROCESSING_LIMITS,
  TRIP_LIMITS,
  type ProcessingState,
  type ProcessingStatusResource,
  type ProcessingStatusResponse,
  type SnapshotResponse,
} from '@trip/contracts';
import { botAction, event, person, workerHeartbeat, type Database } from '@trip/db';
import {
  attachWarningKeys,
  deriveBudgets,
  deriveDayPaths,
  deriveUnknownCoverage,
} from './derive.js';
import { AppError } from './errors.js';
import { tombstonesFor } from './events.js';
import { requireMembership, type TripRow } from './membership.js';
import {
  toBotActionResource,
  toDeletedEventResource,
  toPersonResource,
  toTripResource,
} from './serializers.js';
import { readTripState, readWarnings } from './state.js';
import { enumerateTripDates } from './tripDates.js';
import type { Executor } from './types.js';

export interface SnapshotServiceDeps {
  db: Database;
  /** Worker heartbeats from a different source revision are not trusted. */
  appRevision: string;
}

/**
 * The authoritative read.
 *
 * Taken in one repeatable-read, read-only transaction so members, version and
 * derived state all describe the same committed instant. A sequence of
 * independently timed reads could otherwise report a version that never existed.
 *
 * Budgets, unknown coverage and day paths are derived from this same read
 * rather than stored, so they cannot describe a different instant from the
 * events they summarise. Warnings are stored, because their activation and
 * resolution versions are history that a recomputation would lose.
 */
export async function readSnapshot(
  deps: SnapshotServiceDeps,
  authUserId: string,
  tripId: string,
): Promise<SnapshotResponse> {
  return deps.db.transaction(
    async (tx) => {
      const { trip: tripRow, self } = await requireMembership(tx, tripId, authUserId);

      const memberRows = await tx
        .select()
        .from(person)
        .where(eq(person.tripId, tripId))
        .orderBy(person.colorIndex);
      const members = memberRows.map(toPersonResource);

      const creator = memberRows.find((row) => row.authUserId === tripRow.creatorAuthUserId);
      if (creator === undefined) {
        throw new AppError('INTERNAL', 'trip has no creator membership');
      }

      const processing = await readProcessingStatus(tx, tripRow, deps.appRevision);
      const state = await readTripState(tx, tripId);
      const warnings = await readWarnings(tx, tripId);
      const dates = enumerateTripDates(tripRow.startDate, tripRow.endDate);

      // One bounded page plus one, so "there are older ones" is answered
      // without a second request and without an unbounded read.
      const deletedRows = await tx
        .select()
        .from(event)
        .where(and(eq(event.tripId, tripId), isNotNull(event.deletedAt)))
        .orderBy(desc(event.deletedAt))
        .limit(TRIP_LIMITS.recentDeletionsInSnapshot + 1);
      const recent = deletedRows.slice(0, TRIP_LIMITS.recentDeletionsInSnapshot);
      const stones = await tombstonesFor(
        tx,
        tripId,
        recent.map((row) => row.id),
      );

      const actionRows = await tx
        .select()
        .from(botAction)
        .where(eq(botAction.tripId, tripId))
        .orderBy(desc(botAction.createdAt))
        .limit(50);

      return {
        trip: toTripResource(tripRow, creator.id),
        self_person_id: self.id,
        members,
        events: state.events,
        attendance: state.attendance,
        places: state.places,
        budgets: deriveBudgets(state),
        warnings,
        unknown_coverage: deriveUnknownCoverage(state),
        day_paths: attachWarningKeys(deriveDayPaths(state, dates), warnings),
        actions: actionRows.map(toBotActionResource),
        recent_deletions: recent.map((row) => toDeletedEventResource(row, stones.get(row.id))),
        has_more_deletions: deletedRows.length > TRIP_LIMITS.recentDeletionsInSnapshot,
        calendar_version: tripRow.calendarVersion.toString(),
        processing,
        server_time: new Date().toISOString(),
      } satisfies SnapshotResponse;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/**
 * Cheap poll for members. Deliberately separate from the snapshot so the client
 * can notice a stopped worker without a calendar change event.
 */
export async function readProcessingStatusResponse(
  deps: SnapshotServiceDeps,
  authUserId: string,
  tripId: string,
): Promise<ProcessingStatusResponse> {
  const { trip: tripRow } = await requireMembership(deps.db, tripId, authUserId);
  const processing = await readProcessingStatus(deps.db, tripRow, deps.appRevision);
  return {
    calendar_version: tripRow.calendarVersion.toString(),
    processing,
    server_time: new Date().toISOString(),
  };
}

async function readProcessingStatus(
  exec: Executor,
  tripRow: TripRow,
  appRevision: string,
): Promise<ProcessingStatusResource> {
  const workerAvailable = await hasCompatibleWorker(exec, appRevision);

  // A stopped laptop worker must not be able to look healthy indefinitely, so
  // an absent heartbeat overrides whatever the trip row last recorded.
  const stored = tripRow.processingState as ProcessingState;
  const state: ProcessingState =
    stored === 'disabled' ? 'disabled' : workerAvailable ? stored : 'unavailable';

  return {
    state,
    batch_id: tripRow.processingBatchId,
    attempts: tripRow.processingAttempts,
    next_attempt_at: tripRow.nextProcessAt === null ? null : tripRow.nextProcessAt.toISOString(),
    worker_available: workerAvailable,
    provider_available: stored !== 'disabled',
    pending_user_message_count: tripRow.pendingUserMessageCount,
    last_processed_message_id: tripRow.lastProcessedMsgId.toString(),
    last_error_code: tripRow.processingLastErrorCode,
    updated_at: tripRow.processingUpdatedAt.toISOString(),
  };
}

async function hasCompatibleWorker(exec: Executor, appRevision: string): Promise<boolean> {
  const rows = await exec
    .select({ workerId: workerHeartbeat.workerId })
    .from(workerHeartbeat)
    .where(
      and(
        eq(workerHeartbeat.sourceRevision, appRevision),
        gte(
          workerHeartbeat.lastSeenAt,
          sql`now() - make_interval(secs => ${PROCESSING_LIMITS.workerHeartbeatStaleSeconds})`,
        ),
      ),
    )
    .limit(1);
  return rows[0] !== undefined;
}
