import pg from 'pg';
import { loadRootEnvFile, describeConnection } from './env.js';

/**
 * Redacted privilege check for a runtime credential.
 *
 * Reports what a connection can actually do so "the keys are configured" is
 * never mistaken for "the keys have the right privileges". Prints no secrets.
 */

const TABLES = [
  'trip',
  'person',
  'trip_invite',
  'message',
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

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

async function inspect(label: string, connectionString: string): Promise<boolean> {
  const pool = new pg.Pool({ connectionString, max: 1, application_name: 'trip-planner-roles' });
  try {
    const identity = await pool.query<{
      current_user: string;
      is_superuser: boolean;
      bypassrls: boolean;
    }>(
      `select current_user,
              (select rolsuper from pg_roles where rolname = current_user) as is_superuser,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls`,
    );
    const row = identity.rows[0];
    if (row === undefined) throw new Error('no identity row returned');

    console.log(`\n${label}: ${describeConnection(connectionString)}`);
    console.log(
      `  role=${row.current_user} superuser=${row.is_superuser} bypassrls=${row.bypassrls}`,
    );
    if (row.is_superuser || row.bypassrls) {
      console.log('  WARNING: this credential bypasses row level security.');
    }

    const grants = await pool.query<{
      table_name: string;
      present: boolean;
      owned: boolean | null;
      rls: boolean | null;
      privileges: string[];
    }>(
      `select t.table_name,
              to_regclass('public.'||t.table_name) is not null as present,
              (select pg_get_userbyid(c.relowner) = current_user
                 from pg_class c where c.oid = to_regclass('public.'||t.table_name)) as owned,
              (select c.relrowsecurity
                 from pg_class c where c.oid = to_regclass('public.'||t.table_name)) as rls,
              case when to_regclass('public.'||t.table_name) is null then '{}'::text[]
              else array_remove(array[
                ${PRIVILEGES.map((p) => `case when has_table_privilege(current_user, 'public.'||t.table_name, '${p}') then '${p}' end`).join(',')}
              ], null) end as privileges
       from unnest($1::text[]) as t(table_name)`,
      [TABLES],
    );

    for (const grant of grants.rows) {
      if (!grant.present) {
        console.log(`  ${grant.table_name.padEnd(18)} (table does not exist yet)`);
        continue;
      }
      const notes: string[] = [];
      // A table owner is not subject to its own row level security.
      if (grant.owned === true) notes.push('OWNER: RLS not enforced for this role');
      if (grant.rls === false) notes.push('RLS DISABLED');
      console.log(
        `  ${grant.table_name.padEnd(18)} ${grant.privileges.join(',') || '(none)'}` +
          (notes.length > 0 ? `  [${notes.join('; ')}]` : ''),
      );
    }
    return true;
  } catch (error) {
    console.log(`\n${label}: FAILED - ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  loadRootEnvFile();
  const targets: Array<[string, string | undefined]> = [
    ['API (DATABASE_URL)', process.env['DATABASE_URL']],
    ['Worker (DATABASE_URL_WORKER)', process.env['DATABASE_URL_WORKER']],
  ];
  let checked = 0;
  for (const [label, value] of targets) {
    if (value === undefined || value === '') {
      console.log(`\n${label}: not configured`);
      continue;
    }
    checked += 1;
    await inspect(label, value);
  }
  if (checked === 0) {
    console.log('\nNo runtime database URLs configured.');
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
