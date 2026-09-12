import {
  personColor,
  type MessageKind,
  type MessageResource,
  type PersonResource,
  type TripResource,
} from '@trip/contracts';
import type { message, person, trip } from '@trip/db';
import { enumerateTripDates } from './tripDates.js';

type TripRow = typeof trip.$inferSelect;
type PersonRow = typeof person.$inferSelect;
type MessageRow = typeof message.$inferSelect;

/**
 * @param creatorPersonId membership id of the trip creator, resolved by the
 * caller. The creator's auth user id never leaves the server.
 */
export function toTripResource(row: TripRow, creatorPersonId: string): TripResource {
  const hasBounds =
    row.destinationMinLat !== null &&
    row.destinationMinLon !== null &&
    row.destinationMaxLat !== null &&
    row.destinationMaxLon !== null;

  return {
    id: row.id,
    trip_name: row.tripName,
    group_name: row.groupName,
    expected_headcount: row.expectedHeadcount,
    destination_label: row.destinationLabel,
    destination_center: { lat: row.destinationLat, lon: row.destinationLon },
    destination_bounds: hasBounds
      ? {
          min_lat: row.destinationMinLat as number,
          min_lon: row.destinationMinLon as number,
          max_lat: row.destinationMaxLat as number,
          max_lon: row.destinationMaxLon as number,
        }
      : null,
    timezone: row.timezone,
    currency: 'USD',
    creator_person_id: creatorPersonId,
    start_date: row.startDate,
    end_date: row.endDate,
    dates: enumerateTripDates(row.startDate, row.endDate),
    created_at: row.createdAt.toISOString(),
  };
}

export function toPersonResource(row: PersonRow): PersonResource {
  return {
    id: row.id,
    display_name: row.displayName,
    color_index: row.colorIndex,
    // Resolved server-side so calendar and map cannot pick different palettes.
    color: personColor(row.colorIndex),
    budget_cents: row.budgetCents,
    joined_at: row.createdAt.toISOString(),
  };
}

export function toMessageResource(row: MessageRow): MessageResource {
  return {
    id: row.id.toString(),
    kind: row.kind as MessageKind,
    author_person_id: row.authorPersonId,
    body: row.body,
    created_at: row.createdAt.toISOString(),
    reply_to_message_id: row.replyToMsgId === null ? null : row.replyToMsgId.toString(),
    referenced_event_id: row.referencedEventId,
    client_nonce: row.clientNonce,
    batch_id: row.batchId,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
}
