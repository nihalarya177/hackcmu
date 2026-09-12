import { z } from 'zod';
import {
  bigintString,
  candidateRef,
  cents,
  clientNonce,
  coordinate,
  displayName,
  eventLabel,
  groupName,
  idempotencyKey,
  inviteToken,
  isoTimestamp,
  localDate,
  locationQuery,
  minuteOfDay,
  placeLabel,
  timezoneName,
  tripName,
  uuid,
} from './primitives.js';
import { priceSource, processingState, selfAttendanceChoice, botActionChoice } from './domain.js';
import {
  attendanceResource,
  deletedEventResource,
  eventResource,
  messageResource,
  openingHoursDayResource,
  personResource,
  placeResource,
  tripResource,
} from './resources.js';
import { TRIP_LIMITS } from './limits.js';

/**
 * Every domain mutation carries both an idempotency key and the calendar
 * version the caller believed it was editing. Create, join, invite mint,
 * message send and process have their own documented semantics instead.
 */
export const mutationEnvelope = {
  idempotency_key: idempotencyKey,
  expected_calendar_version: bigintString,
};

const priceFields = {
  price_cents: cents.nullable(),
  price_source: priceSource.nullable(),
};

/** Price value and provenance are set together or not at all. */
const requirePriceConsistency = <T extends { price_cents: number | null; price_source: unknown }>(
  value: T,
  ctx: z.RefinementCtx,
): void => {
  const hasPrice = value.price_cents !== null;
  const hasSource = value.price_source !== null && value.price_source !== undefined;
  if (hasPrice !== hasSource) {
    ctx.addIssue({
      code: 'custom',
      path: ['price_source'],
      message: 'price_cents and price_source must both be set or both be null',
    });
  }
};

/**
 * How a command names a venue. The client never constructs a trusted provider
 * record: it either points at an existing same-trip place, replays a
 * server-issued search candidate, or supplies explicit manual data.
 */
export const placeInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), place_id: uuid }),
  z.strictObject({ kind: z.literal('candidate'), candidate_ref: candidateRef }),
  z.strictObject({
    kind: z.literal('manual'),
    label: placeLabel,
    address: z.string().trim().max(400).nullable().optional(),
    coordinate: coordinate.nullable().optional(),
  }),
  /** Venue named in words but not yet resolved; enrichment picks it up later. */
  z.strictObject({ kind: z.literal('query'), query: locationQuery }),
]);
export type PlaceInput = z.infer<typeof placeInput>;

/* -------------------------------------------------------------------------- */
/* POST /api/trips                                                             */
/* -------------------------------------------------------------------------- */

export const destinationInput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('candidate'),
    candidate_ref: candidateRef,
    /** Supplied only when the provider result has no usable zone. */
    timezone: timezoneName.optional(),
  }),
  z.strictObject({
    kind: z.literal('manual'),
    label: z.string().trim().min(1).max(160),
    center: coordinate,
    timezone: timezoneName,
  }),
]);

export const createTripRequest = z.strictObject({
  idempotency_key: idempotencyKey,
  trip_name: tripName,
  group_name: groupName,
  destination: destinationInput,
  start_date: localDate,
  end_date: localDate,
  expected_headcount: z
    .int()
    .min(TRIP_LIMITS.minExpectedHeadcount)
    .max(TRIP_LIMITS.maxExpectedHeadcount),
  self_display_name: displayName,
  self_budget_cents: cents,
});
export type CreateTripRequest = z.infer<typeof createTripRequest>;

export const inviteIssueResource = z.strictObject({
  /** Delivered once to its owner. Only a hash is stored server-side. */
  token: inviteToken,
  expires_at: isoTimestamp.nullable(),
});

export const createTripResponse = z.strictObject({
  trip: tripResource,
  self: personResource,
  members: z.array(personResource),
  invite: inviteIssueResource,
  calendar_version: bigintString,
});
export type CreateTripResponse = z.infer<typeof createTripResponse>;

/* -------------------------------------------------------------------------- */
/* Invites                                                                     */
/* -------------------------------------------------------------------------- */

export const invitePreviewRequest = z.strictObject({ token: inviteToken });

/**
 * Deliberately minimal. An invite holder is not yet a member, so this must
 * never disclose members, budgets, messages or the plan.
 */
export const invitePreviewResponse = z.strictObject({
  trip_name: tripName,
  group_name: groupName,
  destination_label: z.string(),
  start_date: localDate,
  end_date: localDate,
  join_available: z.boolean(),
  unavailable_reason: z.enum(['trip_full', 'revoked', 'expired']).nullable(),
});
export type InvitePreviewResponse = z.infer<typeof invitePreviewResponse>;

export const joinTripRequest = z.strictObject({
  token: inviteToken,
  display_name: displayName,
  budget_cents: cents,
});
export type JoinTripRequest = z.infer<typeof joinTripRequest>;

export const joinTripResponse = z.strictObject({
  trip: tripResource,
  self: personResource,
  members: z.array(personResource),
  calendar_version: bigintString,
  /** True when this session already had a membership and it was returned as-is. */
  already_member: z.boolean(),
});
export type JoinTripResponse = z.infer<typeof joinTripResponse>;

export const createInviteRequest = z.strictObject({
  idempotency_key: idempotencyKey,
  /** Creator-only. Revokes outstanding links without ejecting anyone. */
  rotate: z.boolean().default(false),
});

export const createInviteResponse = z.strictObject({
  invite: inviteIssueResource,
  revoked_previous: z.int().min(0),
});
export type CreateInviteResponse = z.infer<typeof createInviteResponse>;

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export const listMessagesQuery = z
  .strictObject({
    before_id: bigintString.optional(),
    after_id: bigintString.optional(),
    limit: z.coerce.number().int().min(1).max(TRIP_LIMITS.messagePageMax).default(50),
  })
  .refine((q) => !(q.before_id !== undefined && q.after_id !== undefined), {
    message: 'before_id and after_id are mutually exclusive',
    path: ['after_id'],
  });
export type ListMessagesQuery = z.infer<typeof listMessagesQuery>;

export const listMessagesResponse = z.strictObject({
  /** Ascending by id within the page, regardless of pagination direction. */
  messages: z.array(messageResource),
  has_more: z.boolean(),
  oldest_id: bigintString.nullable(),
  newest_id: bigintString.nullable(),
});
export type ListMessagesResponse = z.infer<typeof listMessagesResponse>;

export const createMessageRequest = z.strictObject({
  body: z.string().min(1).max(TRIP_LIMITS.maxMessageChars),
  client_nonce: clientNonce,
  reply_to_message_id: bigintString.nullable().optional(),
  referenced_event_id: uuid.nullable().optional(),
});
export type CreateMessageRequest = z.infer<typeof createMessageRequest>;

export const createMessageResponse = z.strictObject({
  message: messageResource,
  /** True when this nonce had already been committed and the row was replayed. */
  deduplicated: z.boolean(),
});
export type CreateMessageResponse = z.infer<typeof createMessageResponse>;

/* -------------------------------------------------------------------------- */
/* Processing                                                                  */
/* -------------------------------------------------------------------------- */

export const requestProcessingRequest = z.strictObject({
  idempotency_key: idempotencyKey,
});

export const requestProcessingResponse = z.strictObject({
  state: processingState,
  batch_id: uuid.nullable(),
  /** False when there was nothing pending; the request is then a no-op. */
  queued: z.boolean(),
});
export type RequestProcessingResponse = z.infer<typeof requestProcessingResponse>;

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export const createEventRequest = z
  .strictObject({
    ...mutationEnvelope,
    label: eventLabel,
    local_date: localDate,
    start_minute: minuteOfDay,
    end_minute: minuteOfDay,
    ...priceFields,
    place: placeInput.nullable().default(null),
  })
  .superRefine(requirePriceConsistency);
export type CreateEventRequest = z.infer<typeof createEventRequest>;

/** Whitelisted shared detail edits. There is no arbitrary roster patch here. */
export const patchEventRequest = z
  .strictObject({
    ...mutationEnvelope,
    label: eventLabel.optional(),
    local_date: localDate.optional(),
    start_minute: minuteOfDay.optional(),
    end_minute: minuteOfDay.optional(),
    price_cents: cents.nullable().optional(),
    price_source: priceSource.nullable().optional(),
    place: placeInput.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const hasPrice = 'price_cents' in value;
    const hasSource = 'price_source' in value;
    if (hasPrice !== hasSource) {
      ctx.addIssue({
        code: 'custom',
        path: ['price_source'],
        message: 'price_cents and price_source must be edited together',
      });
      return;
    }
    if (hasPrice) {
      requirePriceConsistency(
        { price_cents: value.price_cents ?? null, price_source: value.price_source ?? null },
        ctx,
      );
    }
  });
export type PatchEventRequest = z.infer<typeof patchEventRequest>;

export const versionedMutationRequest = z.strictObject(mutationEnvelope);

export const restoreEventRequest = z.strictObject({
  ...mutationEnvelope,
  tombstone_id: uuid.nullable().default(null),
});

export const eventMutationResponse = z.strictObject({
  calendar_version: bigintString,
  event: eventResource,
  attendance: z.array(attendanceResource),
  place: placeResource.nullable(),
});
export type EventMutationResponse = z.infer<typeof eventMutationResponse>;

export const deleteEventResponse = z.strictObject({
  calendar_version: bigintString,
  deleted: deletedEventResource,
});
export type DeleteEventResponse = z.infer<typeof deleteEventResponse>;

export const listDeletedEventsQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(TRIP_LIMITS.deletedEventPageMax).default(50),
});

export const listDeletedEventsResponse = z.strictObject({
  items: z.array(deletedEventResource),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type ListDeletedEventsResponse = z.infer<typeof listDeletedEventsResponse>;

/* -------------------------------------------------------------------------- */
/* Self-only properties                                                        */
/* -------------------------------------------------------------------------- */

export const putSelfAttendanceRequest = z.strictObject({
  ...mutationEnvelope,
  state: selfAttendanceChoice,
});
export type PutSelfAttendanceRequest = z.infer<typeof putSelfAttendanceRequest>;

export const attendanceMutationResponse = z.strictObject({
  calendar_version: bigintString,
  event: eventResource.nullable(),
  attendance: z.array(attendanceResource),
});
export type AttendanceMutationResponse = z.infer<typeof attendanceMutationResponse>;

export const patchSelfPersonRequest = z
  .strictObject({
    ...mutationEnvelope,
    display_name: displayName.optional(),
    budget_cents: cents.optional(),
  })
  .refine((v) => v.display_name !== undefined || v.budget_cents !== undefined, {
    message: 'at least one editable field is required',
  });
export type PatchSelfPersonRequest = z.infer<typeof patchSelfPersonRequest>;

export const personMutationResponse = z.strictObject({
  calendar_version: bigintString,
  person: personResource,
});
export type PersonMutationResponse = z.infer<typeof personMutationResponse>;

export const patchTripRequest = z
  .strictObject({
    ...mutationEnvelope,
    trip_name: tripName.optional(),
    group_name: groupName.optional(),
  })
  .refine((v) => v.trip_name !== undefined || v.group_name !== undefined, {
    message: 'at least one editable field is required',
  });
export type PatchTripRequest = z.infer<typeof patchTripRequest>;

export const tripMutationResponse = z.strictObject({
  calendar_version: bigintString,
  trip: tripResource,
});
export type TripMutationResponse = z.infer<typeof tripMutationResponse>;

/* -------------------------------------------------------------------------- */
/* Places                                                                      */
/* -------------------------------------------------------------------------- */

export const placeSearchRequest = z.strictObject({
  query: locationQuery,
  /** Omitted during the creation wizard, before a trip exists. */
  trip_id: uuid.nullable().optional(),
  /** Required when no trip context exists, to bias the search. */
  near: coordinate.nullable().optional(),
});
export type PlaceSearchRequest = z.infer<typeof placeSearchRequest>;

export const placeCandidateResource = z.strictObject({
  candidate_ref: candidateRef,
  label: placeLabel,
  address: z.string().max(400).nullable(),
  coordinate: coordinate.nullable(),
  timezone: timezoneName.nullable(),
});

export const placeSearchResponse = z.strictObject({
  candidates: z.array(placeCandidateResource),
  expires_at: isoTimestamp,
  /** True when the provider is disabled or unreachable; manual entry still works. */
  provider_unavailable: z.boolean(),
});
export type PlaceSearchResponse = z.infer<typeof placeSearchResponse>;

export const patchPlaceRequest = z.strictObject({
  ...mutationEnvelope,
  choice: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('candidate'), candidate_ref: candidateRef }),
    z.strictObject({
      kind: z.literal('manual'),
      label: placeLabel.optional(),
      address: z.string().trim().max(400).nullable().optional(),
      coordinate: coordinate.nullable().optional(),
      hours_days: z.array(openingHoursDayResource).optional(),
    }),
  ]),
});
export type PatchPlaceRequest = z.infer<typeof patchPlaceRequest>;

export const placeMutationResponse = z.strictObject({
  calendar_version: bigintString,
  place: placeResource,
});
export type PlaceMutationResponse = z.infer<typeof placeMutationResponse>;

/* -------------------------------------------------------------------------- */
/* Stored bot actions                                                          */
/* -------------------------------------------------------------------------- */

export const resolveActionRequest = z.strictObject({
  ...mutationEnvelope,
  choice: botActionChoice,
});
export type ResolveActionRequest = z.infer<typeof resolveActionRequest>;

export const resolveActionResponse = z.strictObject({
  calendar_version: bigintString,
  action_id: uuid,
  status: z.enum(['applied', 'dismissed', 'stale']),
});
export type ResolveActionResponse = z.infer<typeof resolveActionResponse>;

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

export const healthLiveResponse = z.strictObject({ status: z.literal('ok') });

export const healthReadyResponse = z.strictObject({
  status: z.enum(['ok', 'degraded']),
  database: z.boolean(),
});
export type HealthReadyResponse = z.infer<typeof healthReadyResponse>;
