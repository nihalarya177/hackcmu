import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHttpServer } from '@trip/server';

/**
 * Vercel Node function entry point.
 *
 * The Fastify instance is built once per warm instance and reused. No
 * migration runs here and no timer outlives the response: background work is
 * the local worker's job, coordinated through the database.
 */
let ready: Promise<Awaited<ReturnType<typeof createHttpServer>>> | null = null;

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  ready ??= createHttpServer();
  const { app } = await ready;
  await app.ready();
  app.server.emit('request', request, response);
}
