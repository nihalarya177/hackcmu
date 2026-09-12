import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventInput } from '@fullcalendar/core';
import { MapPin } from 'lucide-react';
import { TRIP_LIMITS, type SnapshotResponse } from '@trip/contracts';
import { money } from './format';

/**
 * The plan, as the reference calendar draws it: a column per trip day, the
 * clock down the side, and each block carrying its time, its title, where it
 * is and who is going.
 *
 * Roster colours come from `members[].color`, the same source the map reads,
 * so the two views cannot disagree about whose event this is.
 */
export function PlanCalendar({
  snapshot,
  onOpenEvent,
  onPickSlot,
}: {
  snapshot: SnapshotResponse;
  onOpenEvent: (eventId: string) => void;
  onPickSlot: (date: string, startMinute: number) => void;
}): React.ReactElement {
  const people = new Map(snapshot.members.map((person) => [person.id, person]));
  const places = new Map(snapshot.places.map((place) => [place.id, place]));
  const warned = new Set(
    snapshot.warnings.filter((warning) => warning.active).flatMap((warning) => warning.event_ids),
  );

  const events: EventInput[] = snapshot.events.map((event) => {
    const roster = snapshot.attendance
      .filter((row) => row.event_id === event.id && row.state === 'in')
      .map((row) => people.get(row.person_id))
      .filter((person) => person !== undefined);
    const venue = event.place_id === null ? null : (places.get(event.place_id)?.label ?? null);
    const tint = roster[0]?.color ?? '#78716c';

    return {
      id: event.id,
      title: event.label,
      start: event.starts_at,
      end: event.ends_at,
      backgroundColor: `${tint}1a`,
      borderColor: warned.has(event.id) ? '#b45309' : `${tint}4d`,
      textColor: '#1c1917',
      extendedProps: {
        roster,
        venue: venue === event.label ? null : venue,
        price: event.price_cents,
        mine: snapshot.attendance.some(
          (row) =>
            row.event_id === event.id &&
            row.person_id === snapshot.self_person_id &&
            row.state === 'in',
        ),
      },
    };
  });

  const dates = snapshot.trip.dates;
  const first = dates[0] ?? snapshot.trip.start_date;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {snapshot.events.length === 0 && (
        <p className="mb-2 rounded-xl border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-500">
          Nothing planned yet. Agree on something in the conversation, or click a slot to add it
          yourself.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-stone-200 bg-white">
        <div className="min-w-[420px]">
          <FullCalendar
            plugins={[timeGridPlugin, interactionPlugin]}
            initialView="timeGrid"
            initialDate={first}
            visibleRange={{ start: first, end: exclusiveEnd(dates) }}
            timeZone={snapshot.trip.timezone}
            headerToolbar={false}
            allDaySlot={false}
            slotMinTime="07:00:00"
            slotMaxTime="23:00:00"
            slotDuration="00:30:00"
            slotLabelInterval="01:00"
            slotLabelFormat={{ hour: 'numeric', meridiem: 'narrow' }}
            expandRows
            height="auto"
            nowIndicator
            selectable
            selectMirror
            slotEventOverlap={false}
            eventMaxStack={TRIP_LIMITS.maxOverlappingEvents}
            dayHeaderFormat={{ weekday: 'short', day: 'numeric' }}
            events={events}
            eventClick={(info) => onOpenEvent(info.event.id)}
            select={(info) => {
              const start = info.start;
              onPickSlot(info.startStr.slice(0, 10), start.getHours() * 60 + start.getMinutes());
            }}
            eventContent={renderEvent}
          />
        </div>
      </div>
    </div>
  );
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
  const mine = arg.event.extendedProps['mine'] === true;

  return (
    <div className="h-full overflow-hidden px-1.5 py-1 leading-tight">
      <p className="text-[10px] text-stone-500">{arg.timeText}</p>
      <p className="truncate text-[12px] font-semibold text-stone-900">{arg.event.title}</p>
      {venue !== null && (
        <p className="flex items-center gap-0.5 truncate text-[10px] text-stone-500">
          <MapPin aria-hidden className="size-2.5 shrink-0" />
          {venue}
        </p>
      )}
      <div className="mt-0.5 flex items-center gap-1">
        {roster.map((person) => (
          <span
            key={person.id}
            aria-hidden
            className="inline-block size-2 rounded-full ring-1 ring-white"
            style={{ backgroundColor: person.color }}
          />
        ))}
        <span className="ml-auto text-[10px] text-stone-500">
          {price === null ? '—' : money(price)}
        </span>
      </div>
      {mine && <span className="sr-only">You are going</span>}
    </div>
  );
}
