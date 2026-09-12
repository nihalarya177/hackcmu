import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { PROCESSING_LIMITS } from '@trip/contracts';

/**
 * Configuration is validated separately per entry point.
 *
 * The HTTP function must not require a Gemini key it never uses, and the worker
 * must not require a browser origin. A missing value that an entry point
 * actually needs fails that entry point loudly at startup rather than at the
 * first request.
 */

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
      if (pkg.workspaces !== undefined) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Loads the gitignored root .env for local commands only.
 *
 * Vercel and any other hosted runtime inject real environment variables, so
 * this is a no-op there. It never logs or returns the values it loads.
 */
export async function loadLocalEnvFile(): Promise<void> {
  const envPath = path.join(repoRoot(), '.env');
  if (!fs.existsSync(envPath)) return;
  const { config } = await import('dotenv');
  config({ path: envPath, quiet: true });
}

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
    message: 'must be a postgres connection string',
  });

const booleanFlag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const httpEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Restricted API role on the Supabase transaction pooler. */
  DATABASE_URL: postgresUrl,
  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  /** Comma-separated. Same-origin in production; the Vite dev server locally. */
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  API_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(65_536),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(8_000),
  /** Only needed when interactive place search is enabled on the API. */
  PLACES_ENABLED: booleanFlag.default(false),
  GEOAPIFY_API_KEY: z.string().min(1).optional(),
  /** Compared against the worker heartbeat before processing is trusted. */
  APP_REVISION: z.string().min(1).default('dev'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export type HttpConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  allowedOrigins: string[];
  maxBodyBytes: number;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  placesEnabled: boolean;
  geoapifyApiKey: string | null;
  appRevision: string;
  port: number;
};

export function loadHttpConfig(source: NodeJS.ProcessEnv = process.env): HttpConfig {
  const parsed = parseOrThrow(httpEnvSchema, source, 'HTTP API');
  if (parsed.PLACES_ENABLED && parsed.GEOAPIFY_API_KEY === undefined) {
    throw new Error(
      'Invalid HTTP API environment:\n  - GEOAPIFY_API_KEY: required when PLACES_ENABLED is true',
    );
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    supabaseUrl: parsed.SUPABASE_URL,
    supabasePublishableKey: parsed.SUPABASE_PUBLISHABLE_KEY,
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    maxBodyBytes: parsed.API_MAX_BODY_BYTES,
    dbPoolMax: parsed.DB_POOL_MAX,
    dbStatementTimeoutMs: parsed.DB_STATEMENT_TIMEOUT_MS,
    placesEnabled: parsed.PLACES_ENABLED,
    geoapifyApiKey: parsed.GEOAPIFY_API_KEY ?? null,
    appRevision: parsed.APP_REVISION,
    port: parsed.PORT,
  };
}

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Restricted worker role on a session or direct connection, not the pooler. */
  DATABASE_URL_WORKER: postgresUrl,
  /** Shared Supabase settings are optional: these jobs talk to the database. */
  SUPABASE_URL: z.url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  LLM_ENABLED: booleanFlag.default(true),
  GEMINI_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  PLACES_ENABLED: booleanFlag.default(true),
  GEOAPIFY_API_KEY: z.string().min(1).optional(),
  PROCESSING_MODE: z.enum(['normal', 'demo']).default('normal'),
  /** Hard daily ceiling reserved before every outbound provider attempt. */
  LLM_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(0).default(200),
  PLACES_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(0).default(300),
  WORKER_ID: z.string().min(1).optional(),
  APP_REVISION: z.string().min(1).default('dev'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(4),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(15_000),
});

export type WorkerConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  llmEnabled: boolean;
  geminiApiKey: string | null;
  llmModel: string | null;
  placesEnabled: boolean;
  geoapifyApiKey: string | null;
  processingMode: 'normal' | 'demo';
  llmDailyRequestLimit: number;
  placesDailyRequestLimit: number;
  workerId: string;
  appRevision: string;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  heartbeatIntervalMs: number;
  schedulerTickMs: number;
};

export function loadWorkerConfig(source: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = parseOrThrow(workerEnvSchema, source, 'worker');
  const problems: string[] = [];
  if (parsed.LLM_ENABLED) {
    if (parsed.GEMINI_API_KEY === undefined)
      problems.push('GEMINI_API_KEY: required when LLM_ENABLED is true');
    if (parsed.LLM_MODEL === undefined)
      problems.push('LLM_MODEL: required when LLM_ENABLED is true');
  }
  if (parsed.PLACES_ENABLED && parsed.GEOAPIFY_API_KEY === undefined) {
    problems.push('GEOAPIFY_API_KEY: required when PLACES_ENABLED is true');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid worker environment:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL_WORKER,
    llmEnabled: parsed.LLM_ENABLED,
    geminiApiKey: parsed.GEMINI_API_KEY ?? null,
    llmModel: parsed.LLM_MODEL ?? null,
    placesEnabled: parsed.PLACES_ENABLED,
    geoapifyApiKey: parsed.GEOAPIFY_API_KEY ?? null,
    processingMode: parsed.PROCESSING_MODE,
    llmDailyRequestLimit: parsed.LLM_DAILY_REQUEST_LIMIT,
    placesDailyRequestLimit: parsed.PLACES_DAILY_REQUEST_LIMIT,
    workerId: parsed.WORKER_ID ?? `${os.hostname()}-${process.pid}`,
    appRevision: parsed.APP_REVISION,
    dbPoolMax: parsed.DB_POOL_MAX,
    dbStatementTimeoutMs: parsed.DB_STATEMENT_TIMEOUT_MS,
    heartbeatIntervalMs: PROCESSING_LIMITS.workerHeartbeatIntervalSeconds * 1000,
    schedulerTickMs: PROCESSING_LIMITS.schedulerTickMs,
  };
}

function parseOrThrow<T extends z.ZodType>(
  schema: T,
  source: NodeJS.ProcessEnv,
  label: string,
): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Only names and reasons are reported; values are never echoed.
    throw new Error(`Invalid ${label} environment:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
