import { defineConfig } from 'drizzle-kit';

/**
 * Generation only. Migrations are applied by `npm run db:migrate`, which uses
 * the separate migration credential, never the API or worker role.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
