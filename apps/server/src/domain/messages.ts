import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import {
  TRIP_LIMITS,
  type CreateMessageRequest,
  type CreateMessageResponse,
  type ListMessagesQuery,
  type ListMessagesResponse,
} from '@trip/contracts';
import { event, message, trip, type Database } from '@trip/db';
import { AppError, isUniqueViolation } from './errors.js';
import { lockTripAndRequireMembership, requireMembership } from './membership.js';
import { toMessageResource } from './serializers.js';
import type { Executor } from './types.js';

export interface MessageServiceDeps {
  db: Database;
}

/**
 * Bounded history. before_id walks backwards, after_id catches up after a
 * realtime gap, and the default page is the newest slice.
 */
export async function listMessages(
  deps: MessageServiceDeps,
  authUserId: string,
  tripId: string,
  query: ListMessagesQuery,
): Promise<ListMessagesResponse> {
  await requireMembership(deps.db, tripId, authUserId);

  const limit = query.limit;

  if (query.after_id !== undefined) {
    const rows = await deps.db
      .select()
      .from(message)
      .where(and(eq(message.tripId, tripId), gt(message.id, BigInt(query.after_id))))
      .orderBy(asc(message.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return pageResponse(page, rows.length > limit);
  }

  const before = query.before_id === undefined ? undefined : BigInt(query.before_id);
  const rows = await deps.db
    .select()
    .from(message)
    .where(
      before === undefined
        ? eq(message.tripId, tripId)
        : and(eq(message.tripId, tripId), lt(message.id, before)),
    )
    .orderBy(desc(message.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit).reverse();
  return pageResponse(page, rows.length > limit);
}

function pageResponse(
  rows: (typeof message.$inferSelect)[],
  hasMore: boolean,
): ListMessagesResponse {
  const messages = rows.map(toMessageResource);
  return {
    messages,
    has_more: hasMore,
    oldest_id: messages[0]?.id ?? null,
    newest_id: messages[messages.length - 1]?.id ?? null,
  };
}

/**
 * Appends a user message.
 *
 * The trip row is locked before the insert, so the identity column allocates
 * the id inside the serialised section. That is what guarantees no committed
 * user message can ever appear behind an already-advanced watermark.
 */
export async function createMessage(
  deps: MessageServiceDeps,
  authUserId: string,
  tripId: string,
  body: CreateMessageRequest,
): Promise<CreateMessageResponse> {
  try {
    return await deps.db.transaction(async (tx) => {
      const { trip: tripRow, self } = await lockTripAndRequireMembership(tx, tripId, authUserId);

      const existing = await findByNonce(tx, tripId, self.id, body.client_nonce);
      if (existing !== undefined) {
        return { message: toMessageResource(existing), deduplicated: true };
      }

      if (tripRow.userMessageCount >= TRIP_LIMITS.maxUserMessagesPerTrip) {
        throw new AppError('CAPACITY_EXCEEDED', 'This trip has reached its stored message limit');
      }

      const replyToId = await resolveReplyTarget(tx, tripId, body.reply_to_message_id ?? null);
      await assertSameTripEvent(tx, tripId, body.referenced_event_id ?? null);

      const inserted = await tx
        .insert(message)
        .values({
          tripId,
          authorPersonId: self.id,
          kind: 'user',
          body: body.body,
          clientNonce: body.client_nonce,
          replyToMsgId: replyToId,
          referencedEventId: body.referenced_event_id ?? null,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) throw new AppError('INTERNAL', 'message insert returned no row');

      // Chat does not change the calendar, so calendar_version stays put.
      await tx
        .update(trip)
        .set({
          lastUserMsgId: row.id,
          lastUserMessageAt: row.createdAt,
          userMessageCount: sql`${trip.userMessageCount} + 1`,
          pendingUserMessageCount: sql`${trip.pendingUserMessageCount} + 1`,
        })
        .where(eq(trip.id, tripId));

      return { message: toMessageResource(row), deduplicated: false };
    });
  } catch (error) {
    // A concurrent send with the same nonce committed first; return that row.
    if (isUniqueViolation(error, 'message_user_nonce_key')) {
      const membership = await requireMembership(deps.db, tripId, authUserId);
      const existing = await findByNonce(deps.db, tripId, membership.self.id, body.client_nonce);
      if (existing !== undefined) {
        return { message: toMessageResource(existing), deduplicated: true };
      }
    }
    throw error;
  }
}

async function findByNonce(
  exec: Executor,
  tripId: string,
  personId: string,
  nonce: string,
): Promise<typeof message.$inferSelect | undefined> {
  const rows = await exec
    .select()
    .from(message)
    .where(
      and(
        eq(message.tripId, tripId),
        eq(message.authorPersonId, personId),
        eq(message.clientNonce, nonce),
      ),
    )
    .limit(1);
  return rows[0];
}

async function resolveReplyTarget(
  exec: Executor,
  tripId: string,
  replyTo: string | null,
): Promise<bigint | null> {
  if (replyTo === null) return null;
  const id = BigInt(replyTo);
  const rows = await exec
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.tripId, tripId), eq(message.id, id)))
    .limit(1);
  // A reply target from another trip is simply not found here.
  if (rows[0] === undefined) {
    throw new AppError('NOT_FOUND', 'The message being replied to was not found', {
      fieldErrors: [{ path: 'reply_to_message_id', message: 'not found in this trip' }],
    });
  }
  return id;
}

async function assertSameTripEvent(
  exec: Executor,
  tripId: string,
  eventId: string | null,
): Promise<void> {
  if (eventId === null) return;
  const rows = await exec
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.tripId, tripId), eq(event.id, eventId)))
    .limit(1);
  if (rows[0] === undefined) {
    throw new AppError('NOT_FOUND', 'The referenced event was not found', {
      fieldErrors: [{ path: 'referenced_event_id', message: 'not found in this trip' }],
    });
  }
}
