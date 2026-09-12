import ical, { ICalCalendarMethod } from 'ical-generator';
import type { Database } from '@trip/db';
import { attendedEventsOf } from './derive.js';
import { notFound } from './errors.js';
import { requireMembership } from './membership.js';
import { readTripState } from './state.js';
import { toTripResource } from './serializers.js';
import { creatorPersonId } from './membership.js';

/**
 * One person's own calendar.
 *
 * Self-only by construction: the events come from the caller's own attendance,
 * resolved from their verified session. There is no person id to pass, so
 * there is no shape in which one member exports another's plan. Deleted
 * events, and events they are out of or undecided about, are not their plan
 * and are not in the file.
 */
export async function exportSelfCalendar(
  db: Database,
  authUserId: string,
  tripId: string,
): Promise<{ filename: string; body: string }> {
  const { trip: tripRow, self } = await requireMembership(db, tripId, authUserId);
  const state = await readTripState(db, tripId);
  const trip = toTripResource(tripRow, await creatorPersonId(db, tripRow));

  const person = state.members.find((row) => row.id === self.id);
  if (person === undefined) throw notFound('Membership');

  const places = new Map(state.places.map((place) => [place.id, place]));

  // Deliberately no calendar-level timezone: with one set, ical-generator
  // writes floating local times carrying neither a TZID nor a VTIMEZONE, which
  // an importer in another zone reads as the wrong instant. The canonical
  // instants are absolute, so UTC is unambiguous everywhere.
  const calendar = ical({
    name: `${trip.trip_name} — ${person.display_name}`,
    method: ICalCalendarMethod.PUBLISH,
  });

  for (const event of attendedEventsOf(state, person.id)) {
    const place = event.place_id === null ? undefined : places.get(event.place_id);
    calendar.createEvent({
      // Stable per event and revision, so re-importing updates rather than
      // duplicating, and an edited event supersedes its earlier copy.
      id: `${event.id}-${event.revision}`,
      start: new Date(event.starts_at),
      end: new Date(event.ends_at),
      summary: event.label,
      location: place?.address ?? place?.label ?? null,
      description:
        event.price_cents === null
          ? 'Price unknown.'
          : `${(event.price_cents / 100).toFixed(2)} ${trip.currency} per person${
              event.price_source === 'estimate' ? ' (estimated).' : '.'
            }`,
    });
  }

  const slug = person.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'me';
  return {
    filename: `${slug}-${trip.trip_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ics`,
    body: calendar.toString(),
  };
}
