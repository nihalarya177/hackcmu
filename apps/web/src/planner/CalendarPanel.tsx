import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventInput } from '@fullcalendar/core';
import { TRIP_LIMITS, type SnapshotResponse } from '@trip/contracts';
import { money } from './format';

/**
 * FullCalendar Standard over exactly the trip dates, following
 * `design/references/calendar`: one column per day, the time of day down the
 * side, and each block carrying its title and who is going.
 *
 * Rosters are drawn from `members[].color`, the same source the map uses, so
 * the two views cannot disagree about whose event this is.
 */
export function CalendarPanel({
  snapshot,
  onSelectEvent,
}: {
  snapshot: SnapshotResponse;
  onSelectEvent: (eventId: string) => void;
}): React.ReactElement {
  const people = new Map(snapshot.members.map((person) => [person.id, person]));
  const placeLabels = new Map(snapshot.places.map((place) => [place.id, place.label]));
  const warned = new Set(snapshot.warnings.filter((w) => w.active).flatMap((w) => w.event_ids));

  const events: EventInput[] = snapshot.events.map((event) => {
    const roster = snapshot.attendance
      .filter((row) => row.event_id === event.id && row.state === 'in')
      .map((row) => people.get(row.person_id))
      .filter((person) => person !== undefined);

    // The first attendee's colour carries the block, so a split morning reads
    // as two different groups at a glance.
    const tint = roster[0]?.color ?? '#64748b';
    return {
      id: event.id,
      title: event.label,
      start: event.starts_at,
      end: event.ends_at,
      backgroundColor: `${tint}1f`,
      borderColor: warned.has(event.id) ? '#d97706' : `${tint}59`,
      textColor: '#0f172a',
      extendedProps: {
        roster,
        // Only worth a line when it says something the title does not.
        venue: venueLine(event.label, event.place_id, placeLabels),
        price: event.price_cents,
        warned: warned.has(event.id),
      },
    };
  });

  if (snapshot.events.length === 0) {
    return (
      <EmptyableCalendar snapshot={snapshot} events={events} onSelectEvent={onSelectEvent} empty />
    );
  }
  return <EmptyableCalendar snapshot={snapshot} events={events} onSelectEvent={onSelectEvent} />;
}

function EmptyableCalendar({
  snapshot,
  events,
  onSelectEvent,
  empty = false,
}: {
  snapshot: SnapshotResponse;
  events: EventInput[];
  onSelectEvent: (eventId: string) => void;
  empty?: boolean;
}): React.ReactElement {
  const first = snapshot.trip.dates[0] ?? snapshot.trip.start_date;
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {empty && (
        <p className="mb-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
          Nothing is planned yet. Agree on something in chat and press Update plan, or add an event
          yourself.
        </p>
      )}
      {/* Narrow screens scroll the grid sideways rather than compressing it. */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 bg-white">
        <div className="min-w-[460px]">
          <FullCalendar
            plugins={[timeGridPlugin, interactionPlugin]}
            initialView="timeGrid"
            initialDate={first}
            visibleRange={{
              start: first,
              // FullCalendar's exclusive end: the day after the last trip date.
              end: exclusiveEnd(snapshot.trip.dates),
            }}
            timeZone={snapshot.trip.timezone}
            headerToolbar={false}
            allDaySlot={false}
            slotMinTime="07:00:00"
            slotMaxTime="23:00:00"
            expandRows
            height="auto"
            nowIndicator={false}
            slotEventOverlap={false}
            // The domain allows three simultaneous events; show all three.
            eventMaxStack={TRIP_LIMITS.maxOverlappingEvents}
            dayHeaderFormat={{ weekday: 'short', day: 'numeric', month: 'short' }}
            events={events}
            eventClick={(info) => onSelectEvent(info.event.id)}
            eventContent={renderEvent}
          />
        </div>
      </div>
    </section>
  );
}

function venueLine(
  label: string,
  placeId: string | null,
  labels: Map<string, string>,
): string | null {
  if (placeId === null) return null;
  const venue = labels.get(placeId) ?? null;
  return venue === null || venue === label ? null : venue;
}

function exclusiveEnd(dates: string[]): string {
  const last = dates[dates.length - 1] ?? dates[0] ?? '';
  const next = new Date(`${last}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function renderEvent(arg: {
  timeText: string;
  event: { title: string; extendedProps: Record<string, unknown> };
}): React.ReactElement {
  const roster = (arg.event.extendedProps['roster'] ?? []) as { id: string; color: string }[];
  const venue = arg.event.extendedProps['venue'] as string | null;
  const price = arg.event.extendedProps['price'] as number | null;

  return (
    <div className="overflow-hidden px-1 py-0.5 leading-tight">
      <p className="text-[11px] text-slate-600">{arg.timeText}</p>
      <p className="truncate text-[13px] font-semibold text-slate-900">{arg.event.title}</p>
      {venue !== null && <p className="truncate text-[11px] text-slate-600">{venue}</p>}
      <p className="text-[11px] text-slate-600">
        {price === null ? 'price unknown' : money(price)}
      </p>
      <span className="mt-1 flex gap-1">
        {roster.map((person) => (
          <span
            key={person.id}
            aria-hidden
            className="inline-block size-2 rounded-full ring-1 ring-white"
            style={{ backgroundColor: person.color }}
          />
        ))}
      </span>
    </div>
  );
}
