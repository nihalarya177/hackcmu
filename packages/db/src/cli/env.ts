import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Migration environment. Deliberately separate from the API and worker
 * configuration: the credential that can alter schema is never the credential
 * that serves requests.
 */
const migrationEnv = z.object({
  MIGRATION_DATABASE_URL: z
    .string()
    .min(1, 'MIGRATION_DATABASE_URL is required to run migrations')
    .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
      message: 'MIGRATION_DATABASE_URL must be a postgres connection string',
    }),
});

export function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        workspaces?: unknown;
      };
      if (pkg.workspaces !== undefined) return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/** Loads the gitignored root .env for local CLI use only. */
export function loadRootEnvFile(): void {
  loadDotenv({ path: path.join(repoRoot(), '.env'), quiet: true });
}

export function loadMigrationConfig(): z.infer<typeof migrationEnv> {
  loadRootEnvFile();
  const parsed = migrationEnv.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid migration environment:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

/** Describes a connection string without ever revealing the credential. */
export function describeConnection(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || '5432'}${url.pathname} as ${url.username.replace(/./g, '*')}`;
  } catch {
    return '<unparseable connection string>';
  }
}
