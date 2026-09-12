import ical, { ICalCalendarMethod } from 'ical-generator';
import type { EventResource, PlaceResource, TripResource } from '@trip/contracts';

/**
 * One person's own calendar, through the project's chosen serializer rather
 * than hand-rolled string building — escaping and line folding are exactly
 * where a hand-rolled `.ics` goes wrong.
 *
 * Only live events the person is actually attending are included. Deleted
 * events, and events they are out of or undecided about, are not their plan.
 */
export function buildCalendar(options: {
  trip: TripResource;
  events: EventResource[];
  places: PlaceResource[];
  personName: string;
}): { filename: string; content: string } {
  const places = new Map(options.places.map((place) => [place.id, place]));

  // Deliberately no calendar-level timezone: with one set, ical-generator
  // writes floating local times carrying neither a TZID nor a VTIMEZONE, which
  // an importer in another zone reads as the wrong instant. Absolute UTC
  // instants are unambiguous everywhere.
  const calendar = ical({
    name: `${options.trip.trip_name} — ${options.personName}`,
    // A plan someone keeps, not an invitation that asks for a reply.
    method: ICalCalendarMethod.PUBLISH,
  });

  for (const event of options.events) {
    const place = event.place_id === null ? undefined : places.get(event.place_id);
    calendar.createEvent({
      // Stable per event and revision, so re-importing updates rather than
      // duplicating, and an edited event supersedes its earlier copy.
      id: `${event.id}-${event.revision}`,
      // The canonical instants already carry the trip's offset.
      start: new Date(event.starts_at),
      end: new Date(event.ends_at),
      summary: event.label,
      location: place?.address ?? place?.label ?? null,
      description:
        event.price_cents === null
          ? 'Price unknown.'
          : `Estimated ${(event.price_cents / 100).toFixed(2)} ${options.trip.currency} per person.`,
    });
  }

  const slug = options.personName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { filename: `${slug}-trip.ics`, content: calendar.toString() };
}
