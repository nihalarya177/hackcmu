import pg from 'pg';
import { runMigrations } from '@trip/db';
import { requireTestDatabaseUrl } from './testDatabaseUrl.js';

/**
 * Rebuilds the test database from migrations once per run.
 *
 * The anon and authenticated roles are created first so the security migration
 * takes exactly the same branches it takes on hosted Supabase. Without them the
 * RLS policies would silently not exist and the isolation tests would pass for
 * the wrong reason.
 */
export async function setup(): Promise<void> {
  const connectionString = requireTestDatabaseUrl();
  const pool = new pg.Pool({ connectionString, max: 1 });

  try {
    await pool.query(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then
          create role anon nologin noinherit;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then
          create role authenticated nologin noinherit;
        end if;
      end;
      $$;
    `);
    await pool.query('grant usage on schema public to anon, authenticated');

    // Hosted Supabase ships an empty supabase_realtime publication. Creating it
    // here makes the migration take the same branch it takes in production.
    await pool.query(`
      do $$
      begin
        if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
          create publication supabase_realtime;
        end if;
      end;
      $$;
    `);

    await pool.query('drop schema if exists app cascade');
    // The migration journal lives in its own schema; dropping only public would
    // leave drizzle believing every migration had already been applied.
    await pool.query('drop schema if exists drizzle cascade');
    await pool.query('drop schema public cascade');
    await pool.query('create schema public');
    await pool.query('grant usage on schema public to anon, authenticated');
  } finally {
    await pool.end();
  }

  await runMigrations(connectionString);
}
