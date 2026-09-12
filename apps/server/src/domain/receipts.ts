import { and, eq } from 'drizzle-orm';
import { commandReceipt, type Database } from '@trip/db';
import { AppError, isUniqueViolation } from './errors.js';
import { constantTimeEquals, payloadHash } from './hash.js';
import type { Executor, Tx } from './types.js';

export interface ReceiptKey {
  /** Scoped to the verified auth user, so creation works before a trip exists. */
  authUserId: string;
  tripId: string | null;
  command: string;
  idempotencyKey: string;
  /** Canonical request input. Reusing a key with different input is an error. */
  payload: unknown;
}

export interface IdempotentOutcome<T> {
  result: T;
  replayed: boolean;
}

/**
 * Runs a command exactly once per (auth user, command, idempotency key).
 *
 * The receipt is written inside the same transaction as the command's effects,
 * so a lost COMMIT acknowledgement can never leave effects without a receipt or
 * a receipt without effects. A replay is served before any stale-version check,
 * which is what makes a client-side retry of an already-applied edit safe.
 */
export async function runIdempotent<T>(
  db: Database,
  key: ReceiptKey,
  run: (tx: Tx) => Promise<T>,
  parseStoredResult: (stored: unknown) => T,
): Promise<IdempotentOutcome<T>> {
  const hash = payloadHash(key.payload);

  try {
    return await db.transaction(async (tx) => {
      const existing = await findReceipt(tx, key);
      if (existing !== undefined) {
        return { result: replay(existing, hash, parseStoredResult), replayed: true };
      }

      const result = await run(tx);

      await tx.insert(commandReceipt).values({
        authUserId: key.authUserId,
        tripId: key.tripId,
        command: key.command,
        idempotencyKey: key.idempotencyKey,
        payloadHash: hash,
        result,
      });

      return { result, replayed: false };
    });
  } catch (error) {
    // Two concurrent attempts with the same key: one committed, replay it.
    if (isUniqueViolation(error, 'command_receipt_user_command_key')) {
      const existing = await findReceipt(db, key);
      if (existing !== undefined) {
        return { result: replay(existing, hash, parseStoredResult), replayed: true };
      }
    }
    throw error;
  }
}

function replay<T>(
  existing: { payloadHash: Buffer; result: unknown },
  hash: Buffer,
  parseStoredResult: (stored: unknown) => T,
): T {
  if (!constantTimeEquals(existing.payloadHash, hash)) {
    throw new AppError(
      'IDEMPOTENCY_KEY_CONFLICT',
      'This idempotency key was already used with different input',
    );
  }
  return parseStoredResult(existing.result);
}

async function findReceipt(
  exec: Executor,
  key: ReceiptKey,
): Promise<{ payloadHash: Buffer; result: unknown } | undefined> {
  const rows = await exec
    .select({ payloadHash: commandReceipt.payloadHash, result: commandReceipt.result })
    .from(commandReceipt)
    .where(
      and(
        eq(commandReceipt.authUserId, key.authUserId),
        eq(commandReceipt.command, key.command),
        eq(commandReceipt.idempotencyKey, key.idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0];
}
