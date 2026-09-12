import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createInviteRequest,
  createTripRequest,
  invitePreviewRequest,
  joinTripRequest,
  patchSelfPersonRequest,
  patchTripRequest,
  RATE_LIMITS,
  uuid,
} from '@trip/contracts';
import type { Database } from '@trip/db';
import { requireUser } from '../http/auth.js';
import { parseOrThrow } from '../http/errors.js';
import { reserveRequest } from '../domain/rateLimit.js';
import { scopeHash } from '../domain/hash.js';
import {
  createTrip,
  joinTrip,
  mintInvite,
  patchSelfPerson,
  patchTrip,
  previewInvite,
} from '../domain/trips.js';
import { readProcessingStatusResponse, readSnapshot } from '../domain/snapshot.js';

const tripParams = z.object({ tripId: uuid });

export interface TripRouteDeps {
  db: Database;
  appRevision: string;
}

export function registerTripRoutes(app: FastifyInstance, deps: TripRouteDeps): void {
  const { db } = deps;

  app.post('/api/trips', async (request, reply) => {
    const user = requireUser(request);
    const body = parseOrThrow(createTripRequest, request.body);

    // Reserved in its own short statement, before any trip lock is taken.
    await reserveRequest(db, {
      scope: scopeHash('trip_create', user.id),
      endpointClass: 'trip_create',
      limit: RATE_LIMITS.tripCreatePerHourPerSession,
      windowSeconds: 3600,
    });

    const result = await createTrip({ db }, user.id, body);
    void reply.status(201);
    return result;
  });

  app.post('/api/invites/preview', async (request) => {
    requireUser(request);
    const body = parseOrThrow(invitePreviewRequest, request.body);

    await reserveRequest(db, {
      scope: scopeHash('invite_attempt', request.ip),
      endpointClass: 'invite_attempt',
      limit: RATE_LIMITS.inviteAttemptsPerMinutePerIp,
      windowSeconds: 60,
    });

    return previewInvite({ db }, body.token);
  });

  app.post('/api/trips/join', async (request) => {
    const user = requireUser(request);
    const body = parseOrThrow(joinTripRequest, request.body);

    await reserveRequest(db, {
      scope: scopeHash('invite_attempt', request.ip),
      endpointClass: 'invite_attempt',
      limit: RATE_LIMITS.inviteAttemptsPerMinutePerIp,
      windowSeconds: 60,
    });

    return joinTrip({ db }, user.id, body);
  });

  app.post('/api/trips/:tripId/invites', async (request, reply) => {
    const user = requireUser(request);
    const { tripId } = parseOrThrow(tripParams, request.params);
    const body = parseOrThrow(createInviteRequest, request.body);

    const result = await mintInvite({ db }, user.id, tripId, body);
    void reply.status(201);
    return result;
  });

  app.get('/api/trips/:tripId/snapshot', async (request) => {
    const user = requireUser(request);
    const { tripId } = parseOrThrow(tripParams, request.params);
    return readSnapshot({ db, appRevision: deps.appRevision }, user.id, tripId);
  });

  app.get('/api/trips/:tripId/processing', async (request) => {
    const user = requireUser(request);
    const { tripId } = parseOrThrow(tripParams, request.params);
    return readProcessingStatusResponse({ db, appRevision: deps.appRevision }, user.id, tripId);
  });

  app.patch('/api/trips/:tripId/people/me', async (request) => {
    const user = requireUser(request);
    const { tripId } = parseOrThrow(tripParams, request.params);
    const body = parseOrThrow(patchSelfPersonRequest, request.body);
    // Self is derived from the verified session; there is no person id to submit.
    return patchSelfPerson({ db }, user.id, tripId, body);
  });

  app.patch('/api/trips/:tripId', async (request) => {
    const user = requireUser(request);
    const { tripId } = parseOrThrow(tripParams, request.params);
    const body = parseOrThrow(patchTripRequest, request.body);
    return patchTrip({ db }, user.id, tripId, body);
  });
}
