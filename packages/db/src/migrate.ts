import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/**
 * Applies pending migrations with a dedicated privileged connection.
 *
 * This is a controlled deployment step. It is never called from an HTTP
 * handler, a worker tick, or module import side effects.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    application_name: 'trip-planner-migrate',
  });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

export { migrationsFolder };
