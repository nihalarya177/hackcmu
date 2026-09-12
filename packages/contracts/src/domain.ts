import { z } from 'zod';

/** Absence of an attendance row means undecided. */
export const attendanceState = z.enum(['in', 'out']);
export type AttendanceState = z.infer<typeof attendanceState>;

/** The value a member may submit for their own attendance. */
export const selfAttendanceChoice = z.enum(['in', 'out', 'undecided']);
export type SelfAttendanceChoice = z.infer<typeof selfAttendanceChoice>;

/** Who last wrote a row. Human decisions outrank automatic ones. */
export const actorKind = z.enum(['human', 'llm']);
export type ActorKind = z.infer<typeof actorKind>;

/** null price means unknown; 0 means explicitly free. Both fields move together. */
export const priceSource = z.enum(['seeded', 'estimate', 'confirmed']);
export type PriceSource = z.infer<typeof priceSource>;

export const messageKind = z.enum(['user', 'bot', 'system']);
export type MessageKind = z.infer<typeof messageKind>;

export const placeResolution = z.enum(['pending', 'resolved', 'ambiguous', 'unresolved', 'manual']);
export type PlaceResolution = z.infer<typeof placeResolution>;

export const hoursProvenance = z.enum(['provider', 'seed', 'human']);
export type HoursProvenance = z.infer<typeof hoursProvenance>;

export const eventDeletionReason = z.enum(['human', 'auto_zero_attendance']);
export type EventDeletionReason = z.infer<typeof eventDeletionReason>;

export const batchState = z.enum(['queued', 'running', 'retry_wait', 'failed', 'committed']);
export type BatchState = z.infer<typeof batchState>;

/**
 * Trip-level processing state shown to members. `unavailable` means no
 * compatible worker heartbeat; `disabled` means the provider is switched off or
 * the daily ceiling is exhausted. Neither disables manual planning.
 */
export const processingState = z.enum([
  'idle',
  'queued',
  'running',
  'retry_wait',
  'failed',
  'unavailable',
  'disabled',
]);
export type ProcessingState = z.infer<typeof processingState>;

export const botActionType = z.enum(['remove_suggestion', 'revival_undo']);
export type BotActionType = z.infer<typeof botActionType>;

export const botActionStatus = z.enum(['pending', 'applied', 'dismissed', 'stale']);
export type BotActionStatus = z.infer<typeof botActionStatus>;

/** Whitelisted member choices; the server derives the effect and target. */
export const botActionChoice = z.enum(['remove', 'keep', 'undo']);
export type BotActionChoice = z.infer<typeof botActionChoice>;

export const warningKind = z.enum([
  'double_booking',
  'insufficient_travel_time',
  'budget_exceeded',
  'outside_opening_hours',
  'venue_closed',
]);
export type WarningKind = z.infer<typeof warningKind>;

export const budgetStatus = z.enum(['within', 'over', 'unknown']);
export type BudgetStatus = z.infer<typeof budgetStatus>;
