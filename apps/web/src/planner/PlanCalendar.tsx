import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import luxon3Plugin from '@fullcalendar/luxon3';
import type { EventInput } from '@fullcalendar/core';
import { TRIP_LIMITS, type SnapshotResponse } from '@trip/contracts';
import { AvatarRow } from './Avatar';
import { edge, fill, onFill, onFillMuted } from './palette';
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
    const tint = roster[0]?.color ?? '#9b98a5';
    const flagged = warned.has(event.id);

    return {
      id: event.id,
      title: event.label,
      start: event.starts_at,
      end: event.ends_at,
      backgroundColor: fill(tint),
      // A block the planner has flagged gets a ring in its own colour, so the
      // warning above and the thing it is about are visibly the same event.
      borderColor: flagged ? edge(tint) : 'transparent',
      textColor: '#1b1a20',
      extendedProps: {
        roster,
        tint,
        venue: venue === event.label ? null : venue,
        price: event.price_cents,
        flagged,
      },
    };
  });

  const dates = snapshot.trip.dates;
  const first = dates[0] ?? snapshot.trip.start_date;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {snapshot.events.length === 0 && (
        <p className="mb-2.5 rounded-xl bg-sunken px-3.5 py-2.5 text-[13px] text-muted">
          Nothing planned yet. Agree on something in the conversation, or click a slot to add it
          yourself.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-[420px]">
          <FullCalendar
            // Without the Luxon plugin FullCalendar understands only 'local'
            // and 'UTC', and silently renders a named zone as UTC — a 10am
            // agreement in New York drew at 2pm.
            plugins={[timeGridPlugin, interactionPlugin, luxon3Plugin]}
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
            slotLabelClassNames="fc-hour"
            dayHeaderClassNames="fc-day-head"
            eventClassNames="fc-block"
            eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'narrow' }}
            expandRows
            height="auto"
            nowIndicator
            selectable
            selectMirror
            slotEventOverlap={false}
            eventMaxStack={TRIP_LIMITS.maxOverlappingEvents}
            dayHeaderContent={renderDayHeader}
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

function renderDayHeader(arg: { date: Date; text: string }): React.ReactElement {
  const weekday = arg.date.toLocaleDateString('en-US', { weekday: 'short' });
  const day = arg.date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
  return (
    <span className="flex items-baseline gap-2 px-0.5">
      <span className="text-[17px] font-extrabold tracking-tight text-ink">{weekday}</span>
      <span className="text-xs font-semibold text-faint">{day}</span>
    </span>
  );
}

function renderEvent(arg: {
  timeText: string;
  event: { title: string; extendedProps: Record<string, unknown> };
}): React.ReactElement {
  const roster = (arg.event.extendedProps['roster'] ?? []) as {
    id: string;
    display_name: string;
    color: string;
  }[];
  const tint = (arg.event.extendedProps['tint'] ?? '#9b98a5') as string;
  const venue = arg.event.extendedProps['venue'] as string | null;
  const price = arg.event.extendedProps['price'] as number | null;

  return (
    <div className="overflow-hidden px-3 py-2 leading-tight">
      <p className="text-[11px] font-semibold tnum" style={{ color: onFill(tint) }}>
        {arg.timeText}
      </p>
      <p className="mt-0.5 truncate text-[13px] font-bold tracking-tight text-ink">
        {arg.event.title}
      </p>
      {venue !== null && (
        <p className="truncate text-[11px]" style={{ color: onFillMuted(tint) }}>
          {venue}
        </p>
      )}
      {/* Who and how much sit with the title, not pinned to the bottom: a
          long event would otherwise strand them an hour below its name. */}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <AvatarRow people={roster} size={22} ring={fill(tint)} label="Going" />
        <span className="text-[12px] font-bold text-ink tnum">
          {price === null ? '' : money(price)}
        </span>
      </div>
    </div>
  );
}
