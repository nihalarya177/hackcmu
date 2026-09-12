import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTripResponse } from '@trip/contracts';
import {
  authHeaders,
  createHarness,
  resetDatabase,
  tripPayload,
  type Harness,
} from '../support/harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await resetDatabase(harness.pool);
});

/**
 * Runs a query with the privileges the browser actually has.
 *
 * Supabase hands browser sessions the `authenticated` role and exposes the
 * verified subject through a request GUC, so switching role and setting the
 * claim reproduces exactly what a client could attempt directly against
 * PostgREST or Realtime, bypassing this API entirely.
 */
async function asBrowser<T>(
  role: 'authenticated' | 'anon',
  authUserId: string | null,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await harness.pool.connect();
  try {
    await client.query('begin');
    if (authUserId !== null) {
      await client.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', authUserId]);
    }
    await client.query(`set local role ${role}`);
    return await run(client);
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

async function expectDenied(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: '42501' });
}

async function seedTrip() {
  const creator = harness.identity('creator');
  const created = createTripResponse.parse(
    (
      await harness.app.inject({
        method: 'POST',
        url: '/api/trips',
        headers: authHeaders(creator),
        payload: tripPayload(),
      })
    ).json(),
  );
  await harness.app.inject({
    method: 'POST',
    url: `/api/trips/${created.trip.id}/messages`,
    headers: authHeaders(creator),
    payload: { body: 'hello', client_nonce: randomUUID() },
  });
  return { creator, created };
}

describe('row level security', () => {
  it('is enabled on every table the database exposes', async () => {
    const rows = await harness.pool.query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false`,
    );
    expect(rows.rows.map((r) => r.relname)).toEqual([]);
  });

  it('lets a member read their own trip and its messages', async () => {
    const { creator, created } = await seedTrip();

    const visible = await asBrowser('authenticated', creator.authUserId, async (client) => {
      const trips = await client.query('select id from trip');
      const messages = await client.query('select id from message');
      return { trips: trips.rowCount, messages: messages.rowCount };
    });

    expect(visible.trips).toBe(1);
    expect(visible.messages).toBe(1);
    expect(created.trip.id).toBeDefined();
  });

  it('hides another trip from a nonmember reading the database directly', async () => {
    await seedTrip();
    const outsider = harness.identity('outsider');

    const visible = await asBrowser('authenticated', outsider.authUserId, async (client) => {
      const trips = await client.query('select id from trip');
      const messages = await client.query('select id from message');
      return { trips: trips.rowCount, messages: messages.rowCount };
    });

    expect(visible.trips).toBe(0);
    expect(visible.messages).toBe(0);
  });

  it('shows nothing to a session with no verified subject', async () => {
    await seedTrip();
    const visible = await asBrowser('authenticated', null, async (client) => {
      const trips = await client.query('select id from trip');
      return trips.rowCount;
    });
    expect(visible).toBe(0);
  });

  it('refuses every browser write', async () => {
    const { creator, created } = await seedTrip();

    await asBrowser('authenticated', creator.authUserId, async (client) => {
      await expectDenied(client.query("update trip set trip_name = 'hijacked'"));
      await client.query('rollback');
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claim.sub',
        creator.authUserId,
      ]);
      await client.query('set local role authenticated');
      await expectDenied(client.query('delete from message'));
      await client.query('rollback');
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claim.sub',
        creator.authUserId,
      ]);
      await client.query('set local role authenticated');
      await expectDenied(
        client.query(
          `insert into message (trip_id, kind, body) values ($1, 'system', 'fake notice')`,
          [created.trip.id],
        ),
      );
    });
  });

  it('keeps every other table entirely out of reach of the browser', async () => {
    const { creator } = await seedTrip();
    const hidden = [
      'person',
      'trip_invite',
      'place',
      'event',
      'attendance',
      'tombstone',
      'batch_run',
      'command_receipt',
      'warning',
      'bot_action',
      'provider_usage',
      'worker_heartbeat',
      'request_limit',
      'place_candidate',
    ];

    for (const table of hidden) {
      const client = await harness.pool.connect();
      try {
        await client.query('begin');
        await client.query('select set_config($1, $2, true)', [
          'request.jwt.claim.sub',
          creator.authUserId,
        ]);
        await client.query('set local role authenticated');
        await expectDenied(client.query(`select * from ${table} limit 1`));
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
    }
  });

  it('gives the anonymous role no access at all', async () => {
    await seedTrip();
    await asBrowser('anon', null, async (client) => {
      await expectDenied(client.query('select * from trip'));
    });
  });
});

describe('security definer helpers', () => {
  it('pins the search path on every security definer function', async () => {
    const rows = await harness.pool.query<{ proname: string; proconfig: string[] | null }>(
      `select p.proname, p.proconfig
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.prosecdef`,
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      const pinned = (row.proconfig ?? []).some((entry) => entry.startsWith('search_path='));
      expect(pinned, `${row.proname} must pin its search_path`).toBe(true);
    }
  });

  it('is not executable by the public role', async () => {
    const rows = await harness.pool.query<{ ok: boolean }>(
      `select has_function_privilege('public', 'app.is_trip_member(uuid)', 'execute') as ok`,
    );
    expect(rows.rows[0]?.ok).toBe(false);
  });
});

describe('restricted runtime roles', () => {
  it('does not let the API role touch worker-only tables', async () => {
    const client = await harness.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role trip_api');
      await expectDenied(
        client.query(
          `insert into provider_usage (provider, usage_date) values ('gemini', current_date)`,
        ),
      );
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('does not let either runtime role alter schema', async () => {
    for (const role of ['trip_api', 'trip_worker']) {
      const client = await harness.pool.connect();
      try {
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await expect(client.query('drop table message')).rejects.toSatisfy((error: unknown) =>
          String((error as { code?: unknown }).code).startsWith('42'),
        );
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
    }
  });

  it('grants the API role exactly the writes it needs', async () => {
    const rows = await harness.pool.query<{
      table_name: string;
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
    }>(
      `select t.table_name,
              has_table_privilege('trip_api', 'public.'||t.table_name, 'select') as sel,
              has_table_privilege('trip_api', 'public.'||t.table_name, 'insert') as ins,
              has_table_privilege('trip_api', 'public.'||t.table_name, 'update') as upd,
              has_table_privilege('trip_api', 'public.'||t.table_name, 'delete') as del
         from unnest(array['trip','person','message','attendance','batch_run']) as t(table_name)`,
    );
    const byTable = new Map(rows.rows.map((r) => [r.table_name, r]));

    // Chat is append-only; stored history is never edited or deleted.
    expect(byTable.get('message')).toMatchObject({ sel: true, ins: true, upd: false, del: false });
    // Undecided attendance is the absence of a row, so self-edits must delete.
    expect(byTable.get('attendance')).toMatchObject({ del: true });
    // Only the worker claims and commits batches.
    expect(byTable.get('batch_run')).toMatchObject({ sel: true, ins: false, upd: false });
  });
});

describe('realtime publication', () => {
  it('publishes exactly the two tables the browser may observe', async () => {
    const rows = await harness.pool.query<{ tablename: string }>(
      `select tablename from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public'
        order by tablename`,
    );
    expect(rows.rows.map((r) => r.tablename)).toEqual(['message', 'trip']);
  });
});
