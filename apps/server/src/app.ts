import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Database } from '@trip/db';
import type { AccessTokenVerifier } from './auth/verifier.js';
import { bearerToken } from './http/auth.js';
import { registerErrorHandler } from './http/errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerTripRoutes } from './routes/trips.js';

export interface BuildAppOptions {
  db: Database;
  /** Injected so the verification strategy is always explicit at the call site. */
  verifyAccessToken: AccessTokenVerifier;
  allowedOrigins: string[];
  maxBodyBytes: number;
  appRevision: string;
  logger?: boolean;
}

/** Paths reachable without a session. Everything else requires a verified user. */
const PUBLIC_PATHS = new Set(['/health/live', '/health/ready']);

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.maxBodyBytes,
    // Vercel terminates TLS and forwards the client address.
    trustProxy: true,
  });

  await app.register(cors, {
    origin: options.allowedOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  });

  app.decorateRequest('authUser', null);

  /**
   * Authentication, never authorization. This establishes who is calling;
   * membership and self-only rules are enforced separately in the domain layer.
   * The provider call happens here, before any transaction is opened.
   */
  app.addHook('onRequest', async (request) => {
    if (PUBLIC_PATHS.has(request.url.split('?')[0] ?? request.url)) return;
    const token = bearerToken(request);
    if (token === null) return;
    request.authUser = await options.verifyAccessToken(token);
  });

  registerErrorHandler(app);
  registerHealthRoutes(app, options.db);
  registerTripRoutes(app, { db: options.db, appRevision: options.appRevision });
  registerMessageRoutes(app, options.db);

  return app;
}
