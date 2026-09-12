import type { z } from 'zod';
import {
  apiError,
  attendanceMutationResponse,
  deleteEventResponse,
  eventMutationResponse,
  listDeletedEventsResponse,
  placeMutationResponse,
  requestProcessingResponse,
  resolveActionResponse,
  createTripResponse,
  createMessageResponse,
  createInviteResponse,
  invitePreviewResponse,
  joinTripResponse,
  listMessagesResponse,
  personMutationResponse,
  processingStatusResponse,
  snapshotResponse,
  tripMutationResponse,
  type ApiError,
  type CreateEventRequest,
  type CreateInviteResponse,
  type CreateMessageRequest,
  type CreateTripRequest,
  type PatchEventRequest,
  type PatchPlaceRequest,
  type PutSelfAttendanceRequest,
  type ResolveActionRequest,
  type ErrorCode,
  type JoinTripRequest,
  type ListMessagesQuery,
  type PatchSelfPersonRequest,
  type PatchTripRequest,
} from '@trip/contracts';
import { accessToken } from './supabase';
import { loadBrowserConfig } from '../config/env';

/** A failure the UI can branch on without parsing prose. */
export class ApiRequestError extends Error {
  readonly code: ErrorCode | 'NETWORK' | 'MALFORMED_RESPONSE';
  readonly status: number;
  readonly requestId: string | null;
  readonly currentCalendarVersion: string | null;
  readonly retryAfterSeconds: number | null;
  readonly fieldErrors: ApiError['error']['field_errors'];

  constructor(
    code: ErrorCode | 'NETWORK' | 'MALFORMED_RESPONSE',
    message: string,
    options: {
      status?: number;
      requestId?: string | null;
      currentCalendarVersion?: string | null;
      retryAfterSeconds?: number | null;
      fieldErrors?: ApiError['error']['field_errors'];
    } = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = options.status ?? 0;
    this.requestId = options.requestId ?? null;
    this.currentCalendarVersion = options.currentCalendarVersion ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.fieldErrors = options.fieldErrors;
  }
}

async function request<T extends z.ZodType>(
  path: string,
  schema: T,
  init: RequestInit = {},
): Promise<z.infer<T>> {
  const base = loadBrowserConfig().apiBaseUrl;
  const token = await accessToken();

  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (token !== null) headers.set('authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers });
  } catch {
    // Disconnected never means saved: the caller keeps the draft.
    throw new ApiRequestError('NETWORK', 'Could not reach the server', {});
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiError.safeParse(payload);
    if (parsed.success) {
      const { error } = parsed.data;
      throw new ApiRequestError(error.code, error.message, {
        status: response.status,
        requestId: error.request_id,
        currentCalendarVersion: error.current_calendar_version ?? null,
        retryAfterSeconds: error.retry_after_seconds ?? null,
        fieldErrors: error.field_errors,
      });
    }
    throw new ApiRequestError('MALFORMED_RESPONSE', 'Unexpected error response', {
      status: response.status,
    });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // A strict schema makes one unexpected field blank the whole view, so say
    // which field rather than failing anonymously.
    if (import.meta.env.DEV) {
      console.error(`Response from ${path} did not match its contract`, parsed.error.issues);
    }
    throw new ApiRequestError('MALFORMED_RESPONSE', 'Unexpected response shape', {
      status: response.status,
      fieldErrors: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) });
const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });
const del = (body: unknown): RequestInit => ({ method: 'DELETE', body: JSON.stringify(body) });

/** Every domain write carries both of these. */
export type Envelope = { idempotency_key: string; expected_calendar_version: string };

/**
 * Request bodies are typed against the shared contracts. The server parses with
 * strict schemas, so an extra or misspelled field is a 400; typing it here
 * turns that into a compile error instead of a runtime surprise.
 */
export const api = {
  createTrip: (body: CreateTripRequest) => request('/api/trips', createTripResponse, json(body)),

  previewInvite: (token: string) =>
    request('/api/invites/preview', invitePreviewResponse, json({ token })),

  joinTrip: (body: JoinTripRequest) => request('/api/trips/join', joinTripResponse, json(body)),

  mintInvite: (
    tripId: string,
    body: { idempotency_key: string; rotate: boolean },
  ): Promise<CreateInviteResponse> =>
    request(`/api/trips/${tripId}/invites`, createInviteResponse, json(body)),

  snapshot: (tripId: string) => request(`/api/trips/${tripId}/snapshot`, snapshotResponse),

  processing: (tripId: string) =>
    request(`/api/trips/${tripId}/processing`, processingStatusResponse),

  messages: (tripId: string, params: Partial<ListMessagesQuery> = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return request(`/api/trips/${tripId}/messages${suffix}`, listMessagesResponse);
  },

  sendMessage: (tripId: string, body: CreateMessageRequest) =>
    request(`/api/trips/${tripId}/messages`, createMessageResponse, json(body)),

  patchSelf: (tripId: string, body: PatchSelfPersonRequest) =>
    request(`/api/trips/${tripId}/people/me`, personMutationResponse, patch(body)),

  patchTrip: (tripId: string, body: PatchTripRequest) =>
    request(`/api/trips/${tripId}`, tripMutationResponse, patch(body)),

  createEvent: (tripId: string, body: CreateEventRequest) =>
    request(`/api/trips/${tripId}/events`, eventMutationResponse, json(body)),

  patchEvent: (tripId: string, eventId: string, body: PatchEventRequest) =>
    request(`/api/trips/${tripId}/events/${eventId}`, eventMutationResponse, patch(body)),

  deleteEvent: (tripId: string, eventId: string, body: Envelope) =>
    request(`/api/trips/${tripId}/events/${eventId}`, deleteEventResponse, del(body)),

  restoreEvent: (tripId: string, eventId: string, body: Envelope) =>
    request(
      `/api/trips/${tripId}/events/${eventId}/restore`,
      eventMutationResponse,
      json({ ...body, tombstone_id: null }),
    ),

  setSelfAttendance: (tripId: string, eventId: string, body: PutSelfAttendanceRequest) =>
    request(
      `/api/trips/${tripId}/events/${eventId}/attendance/me`,
      attendanceMutationResponse,
      put(body),
    ),

  patchPlace: (tripId: string, placeId: string, body: PatchPlaceRequest) =>
    request(`/api/trips/${tripId}/places/${placeId}`, placeMutationResponse, patch(body)),

  deletions: (tripId: string, params: { cursor?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) query.set(name, String(value));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return request(`/api/trips/${tripId}/deletions${suffix}`, listDeletedEventsResponse);
  },

  requestProcessing: (tripId: string, body: { idempotency_key: string }) =>
    request(`/api/trips/${tripId}/process`, requestProcessingResponse, json(body)),

  resolveAction: (tripId: string, actionId: string, body: ResolveActionRequest) =>
    request(`/api/trips/${tripId}/actions/${actionId}`, resolveActionResponse, json(body)),
};
