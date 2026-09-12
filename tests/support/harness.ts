import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createDatabase, type DatabaseHandle } from '@trip/db';
import { buildApp, type AccessTokenVerifier } from '@trip/server';
import { requireTestDatabaseUrl } from './testDatabaseUrl.js';

export const APP_REVISION = 'test-revision';

export interface TestIdentity {
  authUserId: string;
  token: string;
}

export interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  /** Raw pool for privilege and locking tests that bypass the domain layer. */
  pool: pg.Pool;
  identity: (label?: string) => TestIdentity;
  close: () => Promise<void>;
}

/**
 * Builds the real application with a stubbed token verifier.
 *
 * Only the network call to the auth provider is replaced. Membership,
 * self-only permissions, receipts, locking and the SQL constraints are all the
 * production code paths, which is what these tests exist to exercise.
 */
export async function createHarness(): Promise<Harness> {
  const connectionString = requireTestDatabaseUrl();
  const database = createDatabase({
    connectionString,
    max: 8,
    applicationName: 'trip-planner-test',
    statementTimeoutMs: 15_000,
  });

  const tokens = new Map<string, string>();

  const verifyAccessToken: AccessTokenVerifier = (accessToken) => {
    const authUserId = tokens.get(accessToken);
    return Promise.resolve(authUserId === undefined ? null : { id: authUserId, isAnonymous: true });
  };

  const app = await buildApp({
    db: database.db,
    verifyAccessToken,
    allowedOrigins: ['http://localhost:5173'],
    maxBodyBytes: 65_536,
    appRevision: APP_REVISION,
    // Set TEST_LOG=1 to see server-side detail for an unexpected failure.
    logger: process.env['TEST_LOG'] === '1',
  });

  const pool = new pg.Pool({ connectionString, max: 4 });

  return {
    app,
    database,
    pool,
    identity(label = 'user'): TestIdentity {
      const authUserId = randomUUID();
      const token = `${label}-${randomUUID()}`;
      tokens.set(token, authUserId);
      return { authUserId, token };
    },
    async close(): Promise<void> {
      await app.close();
      await database.close();
      await pool.end();
    },
  };
}

/** Every table that a test may need to clear between cases. */
const TABLES = [
  'attendance',
  'bot_action',
  'tombstone',
  'warning',
  'message',
  'event',
  'place',
  'batch_run',
  'trip_invite',
  'command_receipt',
  'place_candidate',
  'person',
  'trip',
  'request_limit',
  'provider_usage',
  'worker_heartbeat',
];

export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`truncate table ${TABLES.map((t) => `public.${t}`).join(', ')} cascade`);
}

export function authHeaders(identity: TestIdentity): Record<string, string> {
  return { authorization: `Bearer ${identity.token}` };
}

/** A valid trip creation body with sensible defaults. */
export function tripPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotency_key: randomUUID(),
    trip_name: 'Pittsburgh weekend',
    group_name: 'Robotics club',
    destination: {
      kind: 'manual',
      label: 'Pittsburgh, PA',
      center: { lat: 40.4406, lon: -79.9959 },
      timezone: 'America/New_York',
    },
    start_date: '2026-10-02',
    end_date: '2026-10-04',
    expected_headcount: 4,
    self_display_name: 'Ada',
    self_budget_cents: 25_000,
    ...overrides,
  };
}
