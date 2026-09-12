import { sql } from 'drizzle-orm';
import { workerHeartbeat, type Database } from '@trip/db';

/**
 * Records that this worker process is alive and which source revision it runs.
 *
 * The API derives processing availability from this row, so a laptop that goes
 * to sleep stops looking healthy within the staleness window rather than
 * leaving members waiting on work nothing will pick up.
 */
export async function recordHeartbeat(
  db: Database,
  workerId: string,
  sourceRevision: string,
): Promise<void> {
  await db
    .insert(workerHeartbeat)
    .values({ workerId, sourceRevision })
    .onConflictDoUpdate({
      target: workerHeartbeat.workerId,
      // Database time, never the laptop clock.
      set: { sourceRevision, lastSeenAt: sql`now()` },
    });
}
