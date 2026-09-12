import { z } from 'zod';
import { bigintString, isoTimestamp, uuid } from './primitives.js';
import {
  attendanceResource,
  botActionResource,
  dayPathResource,
  deletedEventResource,
  eventResource,
  personBudgetResource,
  personResource,
  placeResource,
  processingStatusResource,
  tripResource,
  unknownCoverageResource,
  warningResource,
} from './resources.js';

/**
 * The authoritative read. Produced from one consistent database read, not a
 * series of independently timed queries. Everything in it is derived from
 * committed state at exactly `calendar_version`.
 */
export const snapshotResponse = z.strictObject({
  trip: tripResource,
  self_person_id: uuid,
  members: z.array(personResource),
  events: z.array(eventResource),
  attendance: z.array(attendanceResource),
  places: z.array(placeResource),
  budgets: z.array(personBudgetResource),
  warnings: z.array(warningResource),
  unknown_coverage: unknownCoverageResource,
  /** One entry per trip date, in trip.dates order. Never a sparse list. */
  day_paths: z.array(dayPathResource),
  /**
   * Pending actions plus a bounded tail of recently resolved ones, so a
   * Remove/Keep pair becomes "Removed by Dana" in the transcript rather than
   * disappearing on the next refetch.
   */
  actions: z.array(botActionResource),
  /** Bounded tail so manual restore is reachable without a second request. */
  recent_deletions: z.array(deletedEventResource),
  has_more_deletions: z.boolean(),
  calendar_version: bigintString,
  processing: processingStatusResource,
  server_time: isoTimestamp,
});
export type SnapshotResponse = z.infer<typeof snapshotResponse>;

/** Cheap poll used while processing is in flight or realtime is down. */
export const processingStatusResponse = z.strictObject({
  calendar_version: bigintString,
  processing: processingStatusResource,
  server_time: isoTimestamp,
});
export type ProcessingStatusResponse = z.infer<typeof processingStatusResponse>;
