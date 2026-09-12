import { and, eq, gte, sql } from 'drizzle-orm';
import {
  PROCESSING_LIMITS,
  type PersonBudgetResource,
  type ProcessingState,
  type ProcessingStatusResource,
  type ProcessingStatusResponse,
  type SnapshotResponse,
} from '@trip/contracts';
import { person, workerHeartbeat, type Database } from '@trip/db';
import { AppError } from './errors.js';
import { requireMembership, type TripRow } from './membership.js';
import { toPersonResource, toTripResource } from './serializers.js';
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
 * Event, place, warning and path projections are filled in by the milestones
 * that own those rules; they are read from this same transaction rather than
 * fetched separately.
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

      return {
        trip: toTripResource(tripRow, creator.id),
        self_person_id: self.id,
        members,
        events: [],
        attendance: [],
        places: [],
        budgets: memberRows.map(emptyBudget),
        warnings: [],
        unknown_coverage: {
          unknown_price_event_ids: [],
          unresolved_place_event_ids: [],
          unknown_hours_event_ids: [],
        },
        day_paths: [],
        actions: [],
        recent_deletions: [],
        has_more_deletions: false,
        calendar_version: tripRow.calendarVersion.toString(),
        processing,
        server_time: new Date().toISOString(),
      } satisfies SnapshotResponse;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** No events exist yet, so nothing is spent and nothing is unknown. */
function emptyBudget(row: typeof person.$inferSelect): PersonBudgetResource {
  return {
    person_id: row.id,
    budget_cents: row.budgetCents,
    known_spend_cents: 0,
    estimate_subtotal_cents: 0,
    confirmed_subtotal_cents: 0,
    unknown_price_event_count: 0,
    status: 'within',
  };
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
