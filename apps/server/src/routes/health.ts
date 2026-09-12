import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@trip/db';
import { describeError } from '../domain/errors.js';

/**
 * Sanitized health checks. Readiness depends on the database only: a stopped
 * local worker degrades processing, which is reported per trip, and must never
 * take the hosted API out of service.
 */
export function registerHealthRoutes(app: FastifyInstance, db: Database): void {
  app.get('/health/live', () => ({ status: 'ok' as const }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ok' as const, database: true };
    } catch (error) {
      app.log.error({ err: describeError(error) }, 'readiness probe failed');
      void reply.status(503);
      return { status: 'degraded' as const, database: false };
    }
  });
}
