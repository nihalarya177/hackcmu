import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];
export type DatabaseHandle = ReturnType<typeof createDatabase>;

export interface DatabaseOptions {
  connectionString: string;
  /** Keep small: Vercel functions and the worker both share Supabase poolers. */
  max: number;
  applicationName: string;
  statementTimeoutMs: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

/**
 * int8 arrives from node-postgres as a string. Parsing it into a JS number
 * would silently lose precision above 2^53, so bigint columns stay exact and
 * are serialized as decimal strings at the API boundary.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value);

export function createDatabase(options: DatabaseOptions) {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    statement_timeout: options.statementTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs ?? 10_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
  });

  const db = drizzle(pool, { schema, casing: 'snake_case' });

  return {
    db,
    pool,
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export { schema };
