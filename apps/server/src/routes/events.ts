import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createEventRequest,
  listDeletedEventsQuery,
  patchEventRequest,
  patchPlaceRequest,
  putSelfAttendanceRequest,
  restoreEventRequest,
  uuid,
  versionedMutationRequest,
} from '@trip/contracts';
import type { Database } from '@trip/db';
import { requireUser } from '../http/auth.js';
import { parseOrThrow } from '../http/errors.js';
import { patchPlace, putSelfAttendance } from '../domain/attendance.js';
import {
  createEvent,
  deleteEvent,
  listDeletedEvents,
  patchEvent,
  restoreEvent,
} from '../domain/events.js';
import { requireMembership } from '../domain/membership.js';

const tripParams = z.object({ tripId: uuid });
const eventParams = z.object({ tripId: uuid, eventId: uuid });
const placeParams = z.object({ tripId: uuid, placeId: uuid });

/** Manual planning. Every write names the version it believed it was editing. */
export function registerEventRoutes(app: FastifyInstance, db: Database): void {
  app.post('/api/trips/:tripId/events', async (request, reply) => {
    const user = requireUser(request);
    const { tripId } = parseOrThrow(tripParams, request.params);
    const body = parseOrThrow(createEventRequest, request.body);
    const result = await createEvent({ db }, user.id, tripId, body);
    void reply.status(201);
    return result;
  });

  app.patch('/api/trips/:tripId/events/:eventId', async (request) => {
    const user = requireUser(request);
    const { tripId, eventId } = parseOrThrow(eventParams, request.params);
    const body = parseOrThrow(patchEventRequest, request.body);
    return patchEvent({ db }, user.id, tripId, eventId, body);
  });

  app.delete('/api/trips/:tripId/events/:eventId', async (request) => {
    const user = requireUser(request);
    const { tripId, eventId } = parseOrThrow(eventParams, request.params);
    const body = parseOrThrow(versionedMutationRequest, request.body);
    return deleteEvent({ db }, user.id, tripId, eventId, body);
  });

  app.post('/api/trips/:tripId/events/:eventId/restore', async (request) => {
    const user = requireUser(request);
    const { tripId, eventId } = parseOrThrow(eventParams, request.params);
    const body = parseOrThrow(restoreEventRequest, request.body);
    return restoreEvent({ db }, user.id, tripId, eventId, body);
  });

  app.put('/api/trips/:tripId/events/:eventId/attendance/me', async (request) => {
    const user = requireUser(request);
    const { tripId, eventId } = parseOrThrow(eventParams, request.params);
    const body = parseOrThrow(putSelfAttendanceRequest, request.body);
    // Self only: there is no person id in the path or the body.
    return putSelfAttendance({ db }, user.id, tripId, eventId, body);
  });

  app.patch('/api/trips/:tripId/places/:placeId', async (request) => {
    const user = requireUser(request);
    const { tripId, placeId } = parseOrThrow(placeParams, request.params);
    const body = parseOrThrow(patchPlaceRequest, request.body);
    return patchPlace({ db }, user.id, tripId, placeId, body);
  });

  app.get('/api/trips/:tripId/deletions', async (request) => {
    const user = requireUser(request);
    const { tripId } = parseOrThrow(tripParams, request.params);
    const query = parseOrThrow(listDeletedEventsQuery, request.query ?? {});
    // Membership is checked before any history is disclosed.
    await requireMembership(db, tripId, user.id);
    return listDeletedEvents(db, tripId, query);
  });
}
