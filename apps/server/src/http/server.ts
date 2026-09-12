import type { FastifyInstance } from 'fastify';
import { createDatabase, type DatabaseHandle } from '@trip/db';
import { buildApp } from '../app.js';
import { createSupabaseVerifier } from '../auth/verifier.js';
import { loadHttpConfig, type HttpConfig } from '../config/env.js';

export interface HttpServer {
  app: FastifyInstance;
  database: DatabaseHandle;
  config: HttpConfig;
}

/**
 * Wires the production HTTP entry point.
 *
 * Importing this module starts no scheduler, no timer and no background work:
 * the worker is a separate entry point by design, so a Vercel function can
 * never begin a job it cannot finish before the response.
 */
export async function createHttpServer(config: HttpConfig = loadHttpConfig()): Promise<HttpServer> {
  const database = createDatabase({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    applicationName: 'trip-planner-api',
    statementTimeoutMs: config.dbStatementTimeoutMs,
  });

  const app = await buildApp({
    db: database.db,
    verifyAccessToken: createSupabaseVerifier({
      supabaseUrl: config.supabaseUrl,
      publishableKey: config.supabasePublishableKey,
    }),
    allowedOrigins: config.allowedOrigins,
    maxBodyBytes: config.maxBodyBytes,
    appRevision: config.appRevision,
    logger: true,
  });

  return { app, database, config };
}
