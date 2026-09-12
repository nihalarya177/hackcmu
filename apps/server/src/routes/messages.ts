import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createMessageRequest, listMessagesQuery, RATE_LIMITS, uuid } from '@trip/contracts';
import type { Database } from '@trip/db';
import { requireUser } from '../http/auth.js';
import { parseOrThrow } from '../http/errors.js';
import { scopeHash } from '../domain/hash.js';
import { reserveRequest } from '../domain/rateLimit.js';
import { createMessage, listMessages } from '../domain/messages.js';

const tripParams = z.object({ tripId: uuid });

export function registerMessageRoutes(app: FastifyInstance, db: Database): void {
  app.get('/api/trips/:tripId/messages', async (request) => {
    const user = requireUser(request);
    const { tripId } = parseOrThrow(tripParams, request.params);
    const query = parseOrThrow(listMessagesQuery, request.query);
    return listMessages({ db }, user.id, tripId, query);
  });

  app.post('/api/trips/:tripId/messages', async (request, reply) => {
    const user = requireUser(request);
    const { tripId } = parseOrThrow(tripParams, request.params);
    const body = parseOrThrow(createMessageRequest, request.body);

    await reserveRequest(db, {
      scope: scopeHash('message_send', tripId, user.id),
      endpointClass: 'message_send',
      limit: RATE_LIMITS.messagesPerMinutePerMember,
      windowSeconds: 60,
    });

    const result = await createMessage({ db }, user.id, tripId, body);
    void reply.status(result.deduplicated ? 200 : 201);
    return result;
  });
}
