import { z } from 'zod';
import { bigintString, uuid } from './primitives.js';
import { messageKind, processingState } from './domain.js';

/**
 * Shapes for the two tables the browser is allowed to observe over Postgres
 * Changes. Everything else reaches the client through HTTP snapshots.
 *
 * These are raw database rows, not API resources, and they differ in two ways
 * that have caused real bugs:
 *
 * 1. Column names, not resource names. `reply_to_msg_id`, not
 *    `reply_to_message_id`.
 * 2. The realtime client converts `int8` columns with `Number()`, so bigint
 *    ids and versions arrive as JavaScript numbers and lose precision above
 *    2^53. They are coerced back to decimal strings here so they can be
 *    compared with `compareVersions` against snapshot values.
 *
 * A realtime notification is an invalidation hint, never authoritative state:
 * refetch the snapshot when it reports a higher calendar version.
 */

export const REALTIME_TABLES = ['trip', 'message'] as const;

/** int8 arrives as a number from the realtime transport; normalise it. */
const wireBigint = z.union([z.number().int(), z.string()]).transform((v) => String(v));

export const realtimeTripRow = z.looseObject({
  id: uuid,
  calendar_version: wireBigint.pipe(bigintString),
  processing_state: processingState.exclude(['unavailable']),
  processing_updated_at: z.string(),
  last_user_msg_id: wireBigint.pipe(bigintString),
});
export type RealtimeTripRow = z.infer<typeof realtimeTripRow>;

export const realtimeMessageRow = z.looseObject({
  id: wireBigint.pipe(bigintString),
  trip_id: uuid,
  kind: messageKind,
  author_person_id: uuid.nullable(),
  body: z.string(),
  client_nonce: uuid.nullable(),
  created_at: z.string(),
});
export type RealtimeMessageRow = z.infer<typeof realtimeMessageRow>;

/**
 * Realtime carries no worker heartbeat, so a stopped worker produces no change
 * event at all. Processing availability must still be polled on this interval
 * even while the realtime connection is healthy.
 */
export const REALTIME_NOTES = {
  processingRequiresPolling: true,
  tripRowOmitsDerivedUnavailableState: true,
} as const;
