import {
  personColor,
  type ActorKind,
  type AttendanceResource,
  type AttendanceState,
  type BotActionResource,
  type BotActionChoice,
  type BotActionStatus,
  type BotActionType,
  type DeletedEventResource,
  type EventDeletionReason,
  type EventResource,
  type HoursProvenance,
  type MessageKind,
  type MessageResource,
  type PersonResource,
  type PlaceResolution,
  type PlaceResource,
  type PriceSource,
  type TripResource,
} from '@trip/contracts';
import type {
  attendance,
  botAction,
  event,
  message,
  person,
  place,
  tombstone,
  trip,
} from '@trip/db';
import { enumerateTripDates } from './tripDates.js';

type TripRow = typeof trip.$inferSelect;
type PersonRow = typeof person.$inferSelect;
type MessageRow = typeof message.$inferSelect;
type EventRow = typeof event.$inferSelect;
type AttendanceRow = typeof attendance.$inferSelect;
type PlaceRow = typeof place.$inferSelect;
type TombstoneRow = typeof tombstone.$inferSelect;
type BotActionRow = typeof botAction.$inferSelect;

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

export function toEventResource(row: EventRow): EventResource {
  return {
    id: row.id,
    place_id: row.placeId,
    label: row.label,
    local_date: row.localDate,
    start_minute: row.startMinute,
    end_minute: row.endMinute,
    starts_at: row.startsAt.toISOString(),
    ends_at: row.endsAt.toISOString(),
    price_cents: row.priceCents,
    price_source: row.priceSource as PriceSource | null,
    created_by: row.createdBy as ActorKind,
    created_by_person_id: row.createdByPersonId,
    schedule_locked_by_human: row.scheduleLockedByHuman,
    revision: row.revision.toString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toAttendanceResource(row: AttendanceRow): AttendanceResource {
  return {
    event_id: row.eventId,
    person_id: row.personId,
    state: row.state as AttendanceState,
    set_by: row.setBy as ActorKind,
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toPlaceResource(row: PlaceRow): PlaceResource {
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    provider_place_id: row.providerPlaceId,
    // The column check keeps these two null together; the contract requires it.
    coordinate: row.lat === null || row.lon === null ? null : { lat: row.lat, lon: row.lon },
    resolution: row.resolution as PlaceResolution,
    revision: row.revision.toString(),
    hours_days: (row.hoursDays as PlaceResource['hours_days'] | null) ?? [],
    hours_provenance: row.hoursProvenance as HoursProvenance | null,
    hours_observed_at: row.hoursObservedAt === null ? null : row.hoursObservedAt.toISOString(),
    human_override: row.humanOverride,
  };
}

/**
 * A removal, described from the event row it came from plus its tombstone.
 * Automatic zero-attendance deletion has no tombstone, which is what stops it
 * from blocking a later recreation of the same visit.
 */
export function toDeletedEventResource(
  row: EventRow,
  tombstoneRow: TombstoneRow | undefined,
): DeletedEventResource {
  return {
    event_id: row.id,
    label: row.label,
    local_date: row.localDate,
    start_minute: row.startMinute,
    reason: (row.deletedReason ?? 'human') as EventDeletionReason,
    deleted_by_person_id: row.deletedByPersonId,
    deleted_at: (row.deletedAt ?? row.updatedAt).toISOString(),
    revision: row.revision.toString(),
    tombstone_id: tombstoneRow?.id ?? null,
  };
}

/**
 * `available_choices` is derived here rather than stored, so the client never
 * hardcodes the action-type-to-buttons mapping and a resolved action cannot be
 * re-offered. An empty array means visible but not actionable.
 */
export function availableChoicesFor(
  type: BotActionType,
  status: BotActionStatus,
): BotActionChoice[] {
  if (status !== 'pending') return [];
  return type === 'remove_suggestion' ? ['remove', 'keep'] : ['undo'];
}

export function toBotActionResource(row: BotActionRow): BotActionResource {
  const type = row.type as BotActionType;
  const status = row.status as BotActionStatus;
  return {
    id: row.id,
    type,
    status,
    available_choices: availableChoicesFor(type, status),
    source_message_id: row.sourceMsgId.toString(),
    target_event_id: row.targetEventId,
    target_tombstone_id: row.targetTombstoneId,
    expected_event_revision:
      row.expectedEventRevision === null ? null : row.expectedEventRevision.toString(),
    resolved_by_person_id: row.resolvedByPersonId,
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
  };
}
