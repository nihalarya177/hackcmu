import { loadMigrationConfig, describeConnection } from './env.js';
import { runMigrations } from '../migrate.js';

/**
 * Controlled deployment step. Confirm the target project before running this:
 * it applies schema changes with a privileged credential.
 */
async function main(): Promise<void> {
  const { MIGRATION_DATABASE_URL } = loadMigrationConfig();
  console.log(`Applying migrations to ${describeConnection(MIGRATION_DATABASE_URL)}`);
  await runMigrations(MIGRATION_DATABASE_URL);
  console.log('Migrations applied.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
