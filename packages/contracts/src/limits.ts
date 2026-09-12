/**
 * Named server-enforced limits from architecture sections 2, 8 and 13.
 * Agents must not invent alternative bounds locally.
 */

export const TRIP_LIMITS = {
  maxMembers: 12,
  maxLiveEvents: 100,
  maxMessageChars: 2000,
  maxUserMessagesPerTrip: 10_000,
  minTripDays: 1,
  maxTripDays: 7,
  maxOverlappingEvents: 3,
  minExpectedHeadcount: 1,
  maxExpectedHeadcount: 12,
  messagePageMax: 100,
  deletedEventPageMax: 100,
  recentDeletionsInSnapshot: 20,
} as const;

/**
 * Immutable person colors. color_index is assigned once at join and never
 * changes; calendar and map both read these exact values so the two views
 * cannot disagree.
 */
export const PERSON_COLORS = [
  '#2563eb',
  '#db2777',
  '#16a34a',
  '#ea580c',
  '#7c3aed',
  '#0891b2',
  '#ca8a04',
  '#dc2626',
  '#4d7c0f',
  '#9333ea',
  '#0d9488',
  '#b45309',
] as const;

export type PersonColorIndex = number;

export function personColor(colorIndex: number): string {
  const color = PERSON_COLORS[colorIndex];
  if (color === undefined) {
    throw new Error(`color_index out of palette range: ${colorIndex}`);
  }
  return color;
}

/** Disclosed defaults when a day is known but a time is not specified. */
export const EVENT_TIME_DEFAULTS = {
  startMinute: 600,
  durationMinutes: 90,
} as const;

/** Straight-line travel estimate. Not a route and not a guarantee. */
export const TRAVEL_ESTIMATE = {
  speedKmPerHour: 25,
} as const;

export const PROCESSING_SETTINGS = {
  normal: {
    userMessageThreshold: 10,
    inactivitySeconds: 15 * 60,
  },
  demo: {
    userMessageThreshold: 3,
    inactivitySeconds: 20,
  },
} as const;

export type ProcessingMode = keyof typeof PROCESSING_SETTINGS;

export const PROCESSING_LIMITS = {
  schedulerTickMs: 2000,
  newMessagesPerBatch: 50,
  contextCompletedBatches: 5,
  contextUserMessageCap: 50,
  supplementalReferencedMessages: 20,
  providerTimeoutMs: 40_000,
  leaseSeconds: 60,
  leaseRenewSeconds: 15,
  automaticAttempts: 3,
  concurrentExtractionCalls: 2,
  maxOperations: 20,
  maxClarifications: 5,
  promptInputTokenBudget: 24_000,
  outputTokenCap: 4000,
  retryBackoffSeconds: [5, 20] as const,
  workerHeartbeatIntervalSeconds: 10,
  workerHeartbeatStaleSeconds: 30,
} as const;

/** Client refresh cadence while realtime is unavailable or work is in flight. */
export const CLIENT_POLL_MS = 5000;

export const RATE_LIMITS = {
  tripCreatePerHourPerSession: 5,
  inviteAttemptsPerMinutePerIp: 20,
  messagesPerMinutePerMember: 30,
  updateRequestsPerMinutePerMember: 6,
  updateRequestTripCooldownSeconds: 10,
  placeSearchesPerMinutePerSession: 10,
} as const;

export type RateLimitClass = keyof typeof RATE_LIMITS;

/** Server-issued place-search candidates expire; expired selections must re-search. */
export const PLACE_CANDIDATE_TTL_SECONDS = 600;

export const CURRENCY = 'USD' as const;
