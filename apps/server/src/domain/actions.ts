import { and, eq, sql } from 'drizzle-orm';
import {
  resolveActionResponse,
  type ResolveActionRequest,
  type ResolveActionResponse,
} from '@trip/contracts';
import { attendance, botAction, event, tombstone, type Database } from '@trip/db';
import { notFound } from './errors.js';
import { availableChoicesFor } from './serializers.js';
import {
  assertExpectedVersion,
  bumpCalendarVersion,
  lockTripAndRequireMembership,
} from './membership.js';
import { runIdempotent } from './receipts.js';
import { deleteZeroAttendanceEvents, readTripState, reconcileWarnings } from './state.js';

/**
 * Resolves one stored Remove/Keep or revival Undo.
 *
 * Both are one-shot and member-accessible, and both are bound to the exact
 * event revision they were created against: any later change to that event —
 * including an attendance-only change — makes the action stale, and a stale
 * action never operates against the revision it did not expect.
 */
export async function resolveAction(
  db: Database,
  authUserId: string,
  tripId: string,
  actionId: string,
  body: ResolveActionRequest,
): Promise<ResolveActionResponse> {
  const { result } = await runIdempotent(
    db,
    {
      authUserId,
      tripId,
      command: 'action.resolve',
      idempotencyKey: body.idempotency_key,
      payload: { actionId, ...body },
    },
    async (tx) => {
      const { trip: tripRow, self } = await lockTripAndRequireMembership(tx, tripId, authUserId);
      assertExpectedVersion(tripRow, body.expected_calendar_version);

      const rows = await tx
        .select()
        .from(botAction)
        .where(and(eq(botAction.tripId, tripId), eq(botAction.id, actionId)))
        .limit(1);
      const action = rows[0];
      if (action === undefined) throw notFound('Action');

      const choices = availableChoicesFor(
        action.type as 'remove_suggestion' | 'revival_undo',
        action.status as 'pending' | 'applied' | 'dismissed' | 'stale',
      );
      if (!choices.includes(body.choice)) {
        // Already resolved, or a choice this action never offered.
        return stale(tripRow.calendarVersion, actionId);
      }

      const targetRows =
        action.targetEventId === null
          ? []
          : await tx
              .select()
              .from(event)
              .where(and(eq(event.tripId, tripId), eq(event.id, action.targetEventId)))
              .limit(1);
      const target = targetRows[0];

      if (
        action.expectedEventRevision !== null &&
        (target === undefined || target.revision !== action.expectedEventRevision)
      ) {
        await markResolved(tx, actionId, 'stale', null);
        return stale(tripRow.calendarVersion, actionId);
      }

      if (body.choice === 'keep') {
        // Dismissing means this evidence cannot propose it again.
        await markResolved(tx, actionId, 'dismissed', self.id);
        return {
          calendar_version: tripRow.calendarVersion.toString(),
          action_id: actionId,
          status: 'dismissed' as const,
        };
      }

      if (target === undefined || target.deletedAt !== null) {
        await markResolved(tx, actionId, 'stale', null);
        return stale(tripRow.calendarVersion, actionId);
      }

      // Remove executes an ordinary human deletion; Undo puts a revival back.
      await tx
        .update(event)
        .set({
          deletedAt: new Date(),
          deletedReason: 'human',
          deletedByPersonId: self.id,
          revision: sql`${event.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(event.tripId, tripId), eq(event.id, target.id)));

      if (body.choice === 'remove') {
        await tx.insert(tombstone).values({
          tripId,
          eventId: target.id,
          occurrenceDate: target.localDate,
          placeId: target.placeId,
          originalLabel: target.label,
          normalizedLabels: [target.normalizedLabel],
          deletedByPersonId: self.id,
        });
      } else if (action.targetTombstoneId !== null) {
        // Undo restores the tombstone the revival had cleared.
        await tx
          .update(tombstone)
          .set({ clearedAt: null, clearedByBatchId: null })
          .where(and(eq(tombstone.tripId, tripId), eq(tombstone.id, action.targetTombstoneId)));
        await tx
          .delete(attendance)
          .where(and(eq(attendance.tripId, tripId), eq(attendance.eventId, target.id)));
      }

      await markResolved(tx, actionId, 'applied', self.id);

      await deleteZeroAttendanceEvents(tx, tripId, self.id);
      const version = await bumpCalendarVersion(tx, tripId);
      const state = await readTripState(tx, tripId);
      await reconcileWarnings(tx, tripId, state, version);

      return {
        calendar_version: version.toString(),
        action_id: actionId,
        status: 'applied' as const,
      };
    },
    (stored) => resolveActionResponse.parse(stored),
  );
  return result;
}

function stale(version: bigint, actionId: string): ResolveActionResponse {
  return {
    calendar_version: version.toString(),
    action_id: actionId,
    status: 'stale',
  };
}

async function markResolved(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  actionId: string,
  status: 'applied' | 'dismissed' | 'stale',
  personId: string | null,
): Promise<void> {
  await tx
    .update(botAction)
    .set({ status, resolvedByPersonId: personId, resolvedAt: new Date() })
    .where(and(eq(botAction.id, actionId), eq(botAction.status, 'pending')));
}
