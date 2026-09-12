import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { PROCESSING_LIMITS, PROCESSING_SETTINGS, type ProcessingMode } from '@trip/contracts';
import {
  attendance,
  batchRun,
  event,
  message,
  person,
  tombstone,
  trip,
  type Database,
} from '@trip/db';
import { describeError } from '../domain/errors.js';
import { requireMembership } from '../domain/membership.js';
import { enumerateTripDates } from '../domain/tripDates.js';
import { extract } from '../llm/gemini.js';
import { parseEnvelope } from '../llm/envelope.js';
import {
  buildUserPrompt,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type PromptContext,
} from '../llm/prompt.js';
import { applyEnvelope, type ApplyContext } from './apply.js';

export interface SchedulerConfig {
  workerId: string;
  appRevision: string;
  mode: ProcessingMode;
  model: string;
  apiKey: string;
  llmEnabled: boolean;
  dailyRequestLimit: number;
}

type TripRow = typeof trip.$inferSelect;

/**
 * One scheduler tick.
 *
 * Everything durable lives in the database: which trips are due, which batch
 * is in flight, who owns it and until when. Stopping the worker pauses
 * processing; starting it again resumes from committed state.
 */
export async function tick(db: Database, config: SchedulerConfig): Promise<void> {
  if (!config.llmEnabled) return;

  await queueDueTrips(db, config.mode);

  const claimed = await claimNextBatch(db, config.workerId);
  if (claimed === null) return;
  await runBatch(db, config, claimed.batch, claimed.leaseToken);
}

/* -------------------------------------------------------------------------- */
/* Triggers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Count and inactivity triggers, evaluated in the database so two workers
 * cannot both decide a trip is due.
 */
async function queueDueTrips(db: Database, mode: ProcessingMode): Promise<void> {
  const settings = PROCESSING_SETTINGS[mode];

  const due = await db
    .select({ id: trip.id })
    .from(trip)
    .where(
      and(
        eq(trip.processingState, 'idle'),
        gt(trip.pendingUserMessageCount, 0),
        or(
          gt(trip.pendingUserMessageCount, settings.userMessageThreshold - 1),
          lte(trip.nextProcessAt, sql`now()`),
        ),
      ),
    )
    .limit(20);

  for (const row of due) {
    await enqueue(db, row.id, 'auto');
  }
}

/**
 * Creates a batch over a fixed message range and marks the trip queued.
 *
 * The range is captured now and never widened: messages arriving mid-run
 * belong to the next batch, which is what keeps a retry replaying the same
 * work rather than a moving target.
 */
export async function enqueue(
  db: Database,
  tripId: string,
  origin: 'auto' | 'manual',
): Promise<{ batchId: string | null; queued: boolean }> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(trip).where(eq(trip.id, tripId)).for('update').limit(1);
    const tripRow = rows[0];
    if (tripRow === undefined) return { batchId: null, queued: false };

    if (tripRow.processingState === 'queued' || tripRow.processingState === 'running') {
      return { batchId: tripRow.processingBatchId, queued: false };
    }
    if (tripRow.processingState === 'disabled') return { batchId: null, queued: false };

    const highest = await tx
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.tripId, tripId), eq(message.kind, 'user')))
      .orderBy(desc(message.id))
      .limit(1);
    const upper = highest[0]?.id;
    // Nothing new to read is a no-op, not a batch that pretends to work.
    if (upper === undefined || upper <= tripRow.lastProcessedMsgId) {
      return { batchId: null, queued: false };
    }

    const inserted = await tx
      .insert(batchRun)
      .values({
        tripId,
        lowerExclusiveMsgId: tripRow.lastProcessedMsgId,
        upperInclusiveMsgId: upper,
        capturedCalendarVersion: tripRow.calendarVersion,
        status: 'queued',
      })
      .returning({ id: batchRun.id });
    const batchId = inserted[0]?.id ?? null;

    await tx
      .update(trip)
      .set({
        processingState: 'queued',
        processingBatchId: batchId,
        processingAttempts: 0,
        processingLastErrorCode: null,
        nextProcessAt: null,
        processingUpdatedAt: new Date(),
      })
      .where(eq(trip.id, tripId));

    void origin;
    return { batchId, queued: true };
  });
}

/** Manual "update the plan now", from a member. */
export async function requestProcessing(
  db: Database,
  authUserId: string,
  tripId: string,
): Promise<{ state: string; batch_id: string | null; queued: boolean }> {
  const { trip: tripRow } = await requireMembership(db, tripId, authUserId);
  if (tripRow.processingState === 'disabled') {
    return { state: 'disabled', batch_id: null, queued: false };
  }
  const result = await enqueue(db, tripId, 'manual');
  const after = await db.select().from(trip).where(eq(trip.id, tripId)).limit(1);
  return {
    state: after[0]?.processingState ?? 'idle',
    batch_id: result.batchId,
    queued: result.queued,
  };
}

/* -------------------------------------------------------------------------- */
/* Leases                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Claims one due batch under a fresh lease token.
 *
 * A lease that has expired can be taken over, and the previous owner's writes
 * are fenced by that token: it may no longer finish the batch it lost.
 */
async function claimNextBatch(
  db: Database,
  workerId: string,
): Promise<{ batch: typeof batchRun.$inferSelect; leaseToken: string } | null> {
  const leaseToken = randomUUID();

  const rows = await db.execute(sql`
    update batch_run
       set status = 'running',
           lease_token = ${leaseToken},
           lease_expires_at = now() + make_interval(secs => ${PROCESSING_LIMITS.leaseSeconds}),
           claimed_at = now(),
           started_at = coalesce(started_at, now()),
           attempts = attempts + 1,
           updated_at = now()
     where id = (
       select id from batch_run
        where status in ('queued','retry_wait')
          and (next_attempt_at is null or next_attempt_at <= now())
          and (lease_expires_at is null or lease_expires_at < now())
        order by created_at asc
        for update skip locked
        limit 1
     )
    returning *
  `);

  const row = (rows as unknown as { rows?: Record<string, unknown>[] }).rows?.[0];
  if (row === undefined) return null;

  const batch = await db
    .select()
    .from(batchRun)
    .where(eq(batchRun.id, row['id'] as string))
    .limit(1);
  const claimed = batch[0];
  if (claimed === undefined) return null;

  await db
    .update(trip)
    .set({ processingState: 'running', processingUpdatedAt: new Date() })
    .where(eq(trip.id, claimed.tripId));

  void workerId;
  return { batch: claimed, leaseToken };
}

/* -------------------------------------------------------------------------- */
/* Running a batch                                                             */
/* -------------------------------------------------------------------------- */

async function runBatch(
  db: Database,
  config: SchedulerConfig,
  batch: typeof batchRun.$inferSelect,
  leaseToken: string,
): Promise<void> {
  let renew: NodeJS.Timeout | undefined;
  try {
    renew = setInterval(() => {
      void db
        .update(batchRun)
        .set({
          leaseExpiresAt: sql`now() + make_interval(secs => ${PROCESSING_LIMITS.leaseSeconds})`,
        })
        .where(and(eq(batchRun.id, batch.id), eq(batchRun.leaseToken, leaseToken)))
        .catch(() => undefined);
    }, PROCESSING_LIMITS.leaseRenewSeconds * 1000);

    const context = await buildContext(db, batch);
    if (context === null) {
      await finishBatch(db, batch, leaseToken, {
        status: 'committed',
        accepted: 0,
        rejections: [],
      });
      return;
    }

    // The provider call happens outside every transaction.
    const answer = await extract({
      model: config.model,
      apiKey: config.apiKey,
      userPrompt: buildUserPrompt(context.prompt),
    });
    const { envelope, discarded } = parseEnvelope(answer.text);

    await db.transaction(async (tx) => {
      // Ownership fence: a lost lease may not commit.
      const owned = await tx
        .select({ id: batchRun.id })
        .from(batchRun)
        .where(and(eq(batchRun.id, batch.id), eq(batchRun.leaseToken, leaseToken)))
        .limit(1);
      if (owned[0] === undefined) throw new Error('lease_lost');

      const tripRows = await tx
        .select()
        .from(trip)
        .where(eq(trip.id, batch.tripId))
        .for('update')
        .limit(1);
      const tripRow = tripRows[0];
      if (tripRow === undefined) throw new Error('trip_gone');

      const outcome = await applyEnvelope(tx, context.apply, envelope);
      // Operations discarded before the domain saw them are rejections too.
      outcome.rejections.push(...discarded);

      for (const text of outcome.notices) {
        await postBotMessage(tx, tripRow, batch.id, text);
      }
      if (outcome.accepted > 0) {
        await postBotMessage(
          tx,
          tripRow,
          batch.id,
          `Updated the plan from the conversation: ${outcome.accepted} change${outcome.accepted === 1 ? '' : 's'}.`,
        );
      }

      // The watermark advances exactly to the captured upper bound, never to
      // "the latest message", so anything that arrived mid-run is not skipped.
      await tx
        .update(trip)
        .set({
          lastProcessedMsgId: batch.upperInclusiveMsgId,
          pendingUserMessageCount: sql`greatest(0, ${trip.pendingUserMessageCount} - ${Number(batch.upperInclusiveMsgId - batch.lowerExclusiveMsgId)})`,
          processingState: 'idle',
          processingBatchId: null,
          processingAttempts: 0,
          processingLastErrorCode: null,
          nextProcessAt: null,
          processingUpdatedAt: new Date(),
        })
        .where(eq(trip.id, batch.tripId));

      await tx
        .update(batchRun)
        .set({
          status: 'committed',
          finishedAt: new Date(),
          model: config.model,
          promptVersion: PROMPT_VERSION,
          schemaVersion: SCHEMA_VERSION,
          output: envelope,
          acceptedCount: outcome.accepted,
          rejections: outcome.rejections,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(batchRun.id, batch.id));
    });
  } catch (error) {
    await failBatch(db, batch, leaseToken, error);
  } finally {
    if (renew !== undefined) clearInterval(renew);
  }
}

async function failBatch(
  db: Database,
  batch: typeof batchRun.$inferSelect,
  leaseToken: string,
  error: unknown,
): Promise<void> {
  const code = errorCodeOf(error);
  const attempt = batch.attempts;
  const backoff = PROCESSING_LIMITS.retryBackoffSeconds[attempt - 1];
  const willRetry = backoff !== undefined && attempt < PROCESSING_LIMITS.automaticAttempts;

  await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: batchRun.id })
      .from(batchRun)
      .where(and(eq(batchRun.id, batch.id), eq(batchRun.leaseToken, leaseToken)))
      .limit(1);
    // A worker that lost its lease must not overwrite the new owner's state.
    if (owned[0] === undefined) return;

    await tx
      .update(batchRun)
      .set({
        status: willRetry ? 'retry_wait' : 'failed',
        errorCode: code,
        nextAttemptAt: willRetry ? sql`now() + make_interval(secs => ${backoff})` : null,
        finishedAt: willRetry ? null : new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(batchRun.id, batch.id));

    await tx
      .update(trip)
      .set({
        processingState: willRetry ? 'retry_wait' : 'failed',
        processingAttempts: attempt,
        processingLastErrorCode: code,
        nextProcessAt: willRetry ? sql`now() + make_interval(secs => ${backoff})` : null,
        processingUpdatedAt: new Date(),
      })
      .where(eq(trip.id, batch.tripId));
  });
}

async function finishBatch(
  db: Database,
  batch: typeof batchRun.$inferSelect,
  leaseToken: string,
  result: { status: string; accepted: number; rejections: unknown[] },
): Promise<void> {
  await db
    .update(batchRun)
    .set({
      status: result.status,
      acceptedCount: result.accepted,
      rejections: result.rejections,
      finishedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(and(eq(batchRun.id, batch.id), eq(batchRun.leaseToken, leaseToken)));

  await db
    .update(trip)
    .set({
      lastProcessedMsgId: batch.upperInclusiveMsgId,
      processingState: 'idle',
      processingBatchId: null,
      processingUpdatedAt: new Date(),
    })
    .where(eq(trip.id, batch.tripId));
}

function errorCodeOf(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('provider_')) return error.message;
  if (error instanceof Error && error.message === 'lease_lost') return 'lease_lost';
  const described = describeError(error);
  return (described['code'] ?? 'internal_error').slice(0, 80);
}

/** A bot line in the transcript, allocated under the held trip lock. */
async function postBotMessage(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  tripRow: TripRow,
  batchId: string,
  body: string,
): Promise<void> {
  // The identity column allocates inside the held trip lock, so a bot line
  // can never land behind an already-advanced watermark.
  await tx.insert(message).values({
    tripId: tripRow.id,
    kind: 'bot',
    authorPersonId: null,
    body,
    batchId,
  });
}

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

async function buildContext(
  db: Database,
  batch: typeof batchRun.$inferSelect,
): Promise<{ prompt: PromptContext; apply: ApplyContext } | null> {
  const tripRows = await db.select().from(trip).where(eq(trip.id, batch.tripId)).limit(1);
  const tripRow = tripRows[0];
  if (tripRow === undefined) return null;

  const members = await db.select().from(person).where(eq(person.tripId, batch.tripId));
  const events = await db
    .select()
    .from(event)
    .where(and(eq(event.tripId, batch.tripId), isNull(event.deletedAt)));
  const rosters = await db
    .select()
    .from(attendance)
    .where(and(eq(attendance.tripId, batch.tripId), eq(attendance.state, 'in')));
  const stones = await db
    .select()
    .from(tombstone)
    .where(and(eq(tombstone.tripId, batch.tripId), isNull(tombstone.clearedAt)));

  const current = await db
    .select()
    .from(message)
    .where(
      and(
        eq(message.tripId, batch.tripId),
        gt(message.id, batch.lowerExclusiveMsgId),
        lte(message.id, batch.upperInclusiveMsgId),
      ),
    )
    .orderBy(asc(message.id))
    .limit(PROCESSING_LIMITS.newMessagesPerBatch);
  if (current.length === 0) return null;

  const history = await db
    .select()
    .from(message)
    .where(and(eq(message.tripId, batch.tripId), lte(message.id, batch.lowerExclusiveMsgId)))
    .orderBy(desc(message.id))
    .limit(PROCESSING_LIMITS.contextUserMessageCap);

  const names = new Map(members.map((row) => [row.id, row.displayName]));
  const describe = (row: typeof message.$inferSelect) => ({
    id: row.id.toString(),
    author: row.authorPersonId === null ? null : (names.get(row.authorPersonId) ?? null),
    body: row.body,
  });

  const authorOf = new Map<string, string | null>();
  for (const row of [...history, ...current]) {
    authorOf.set(row.id.toString(), row.authorPersonId);
  }

  const dates = enumerateTripDates(tripRow.startDate, tripRow.endDate);

  return {
    prompt: {
      timezone: tripRow.timezone,
      dates,
      members: members.map((row) => ({ id: row.id, name: row.displayName })),
      events: events.map((row) => ({
        id: row.id,
        label: row.label,
        local_date: row.localDate,
        start_minute: row.startMinute,
        end_minute: row.endMinute,
        attendees: rosters.filter((a) => a.eventId === row.id).map((a) => a.personId),
        locked: row.scheduleLockedByHuman,
      })),
      tombstones: stones.map((row) => ({
        id: row.id,
        label: row.originalLabel,
        date: row.occurrenceDate,
      })),
      history: history.reverse().map(describe),
      current: current.map(describe),
    },
    apply: {
      tripId: batch.tripId,
      timezone: tripRow.timezone,
      dates,
      lowerExclusiveMsgId: batch.lowerExclusiveMsgId,
      upperInclusiveMsgId: batch.upperInclusiveMsgId,
      batchId: batch.id,
      memberIds: new Set(members.map((row) => row.id)),
      authorOf,
    },
  };
}
