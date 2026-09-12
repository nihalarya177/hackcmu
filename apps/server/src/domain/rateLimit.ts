import { sql } from 'drizzle-orm';
import type { Database } from '@trip/db';
import { AppError } from './errors.js';

export interface RateLimitReservation {
  /** Hashed actor scope. Never a raw address, token or user id. */
  scope: Buffer;
  endpointClass: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Reserves one request against a durable counter.
 *
 * Counters live in Postgres so the limit holds across Vercel instances rather
 * than per process. This runs as its own short statement before the mutation
 * transaction, so a counter lock is never held while waiting for a trip lock.
 */
export async function reserveRequest(
  db: Database,
  reservation: RateLimitReservation,
): Promise<void> {
  const { scope, endpointClass, limit, windowSeconds } = reservation;

  const result = await db.execute<{ count: number; expires_at: Date }>(sql`
    insert into request_limit (scope_hash, endpoint_class, bucket_start, count, expires_at)
    values (
      ${scope},
      ${endpointClass},
      to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}),
      1,
      to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds})
        + make_interval(secs => ${windowSeconds})
    )
    on conflict (scope_hash, endpoint_class, bucket_start)
      do update set count = request_limit.count + 1
    returning request_limit.count, request_limit.expires_at
  `);

  const row = result.rows[0];
  if (row === undefined) return;
  if (row.count > limit) {
    const retryAfter = Math.max(
      1,
      Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 1000),
    );
    throw new AppError('RATE_LIMITED', 'Too many requests; try again shortly', {
      retryAfterSeconds: retryAfter,
    });
  }
}

/**
 * Removes counters whose window has closed. Called by the worker: API decisions
 * always use the current bucket, so delayed cleanup never blocks a request.
 */
export async function purgeExpiredRequestLimits(db: Database): Promise<number> {
  const result = await db.execute(sql`delete from request_limit where expires_at < now()`);
  return result.rowCount ?? 0;
}
