import { useState } from 'react';
import { Check, Minus, Trash2, X } from 'lucide-react';
import type { SelfAttendanceChoice, SnapshotResponse } from '@trip/contracts';
import { api } from '../lib/api';
import { clock, commandKey, dayLabel, inputFromMinute, minuteFromInput, money } from './format';
import { VenueFields } from './VenueFields';

export type EventTarget =
  { kind: 'new'; date: string; startMinute: number } | { kind: 'existing'; eventId: string };

const ATTENDANCE: { value: SelfAttendanceChoice; label: string; icon: typeof Check }[] = [
  { value: 'in', label: 'Going', icon: Check },
  { value: 'out', label: 'Not going', icon: X },
  { value: 'undecided', label: 'Undecided', icon: Minus },
];

/**
 * Everything you can do to one event, in the place you clicked it: whether you
 * are going, what it is, where and when, and what it costs.
 *
 * Attendance is self-only by construction. There is no control here for anyone
 * else's choice, because no endpoint would accept one.
 */
export function EventDetail({
  snapshot,
  target,
  onClose,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  target: EventTarget;
  onClose: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const existing =
    target.kind === 'existing'
      ? snapshot.events.find((event) => event.id === target.eventId)
      : undefined;

  if (target.kind === 'existing' && existing === undefined) {
    return (
      <Panel title="That event is gone" onClose={onClose}>
        <p className="text-sm text-stone-600">
          It was removed or changed while this was open. Close this and take another look.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title={existing?.label ?? 'Add to the plan'}
      subtitle={
        existing === undefined
          ? undefined
          : `${dayLabel(existing.local_date)} · ${clock(existing.start_minute)} – ${clock(existing.end_minute)}`
      }
      onClose={onClose}
    >
      {existing !== undefined && (
        <>
          <Attendance
            snapshot={snapshot}
            eventId={existing.id}
            onChanged={onChanged}
            onError={onError}
            onGone={onClose}
          />
          <Roster snapshot={snapshot} eventId={existing.id} />
          <Warnings snapshot={snapshot} eventId={existing.id} />
        </>
      )}
      <Fields
        snapshot={snapshot}
        target={target}
        onClose={onClose}
        onChanged={onChanged}
        onError={onError}
      />
    </Panel>
  );
}

function Attendance({
  snapshot,
  eventId,
  onChanged,
  onError,
  onGone,
}: {
  snapshot: SnapshotResponse;
  eventId: string;
  onChanged: () => void;
  onError: (error: unknown) => void;
  onGone: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const mine = snapshot.attendance.find(
    (row) => row.event_id === eventId && row.person_id === snapshot.self_person_id,
  );
  const current: SelfAttendanceChoice = mine?.state ?? 'undecided';

  const choose = (state: SelfAttendanceChoice): void => {
    setBusy(true);
    void api
      .setSelfAttendance(snapshot.trip.id, eventId, {
        idempotency_key: commandKey('attend'),
        expected_calendar_version: snapshot.calendar_version,
        state,
      })
      .then((result) => {
        onChanged();
        // Leaving can take the last attendee with it, and the event goes with
        // them. Closing is kinder than leaving a panel about something gone.
        if (result.event === null) onGone();
      }, onError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex gap-1.5">
        {ATTENDANCE.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            disabled={busy}
            aria-pressed={current === value}
            onClick={() => choose(value)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
              current === value
                ? 'border-stone-800 bg-stone-800 text-white'
                : 'border-stone-300 bg-white text-stone-700 hover:border-stone-400'
            }`}
          >
            <Icon aria-hidden className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-stone-500">
        If everyone leaves, the event comes off the calendar.
      </p>
    </div>
  );
}

function Roster({
  snapshot,
  eventId,
}: {
  snapshot: SnapshotResponse;
  eventId: string;
}): React.ReactElement | null {
  const going = snapshot.attendance
    .filter((row) => row.event_id === eventId && row.state === 'in')
    .map((row) => snapshot.members.find((person) => person.id === row.person_id))
    .filter((person) => person !== undefined);
  if (going.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-1.5">
      {going.map((person) => (
        <li
          key={person.id}
          className="flex items-center gap-1.5 rounded-full bg-stone-100 py-0.5 pr-2.5 pl-1.5 text-xs text-stone-700"
        >
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: person.color }}
          />
          {person.display_name}
        </li>
      ))}
    </ul>
  );
}

function Warnings({
  snapshot,
  eventId,
}: {
  snapshot: SnapshotResponse;
  eventId: string;
}): React.ReactElement | null {
  const names = new Map(snapshot.members.map((person) => [person.id, person.display_name]));
  const relevant = snapshot.warnings.filter(
    (warning) => warning.active && warning.event_ids.includes(eventId),
  );
  if (relevant.length === 0) return null;

  return (
    <ul className="grid gap-1">
      {relevant.map((warning) => (
        <li
          key={warning.key}
          className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900"
        >
          {describeWarning(warning, names, snapshot)}
        </li>
      ))}
    </ul>
  );
}

export function describeWarning(
  warning: SnapshotResponse['warnings'][number],
  names: Map<string, string>,
  snapshot: SnapshotResponse,
): string {
  const who = warning.person_id === null ? null : (names.get(warning.person_id) ?? 'Someone');
  const labels = warning.event_ids
    .map((id) => snapshot.events.find((event) => event.id === id)?.label)
    .filter((label) => label !== undefined);

  switch (warning.kind) {
    case 'double_booking':
      return `${who ?? 'Someone'} is in two places at once — ${labels.join(' and ')} overlap by ${warning.details.overlap_minutes} minutes.`;
    case 'budget_exceeded':
      return `${who ?? 'Someone'} is over budget: ${money(warning.details.known_spend_cents)} committed against ${money(warning.details.budget_cents)}.`;
    case 'insufficient_travel_time':
      return `${who ?? 'Someone'} has ${warning.details.available_minutes} minutes to get between ${labels.join(' and ')}; the straight-line estimate needs ${warning.details.required_minutes ?? '?'}.`;
    case 'venue_closed':
      return `The venue is recorded as closed that day.`;
    case 'outside_opening_hours':
      return `This runs outside the venue's recorded opening hours.`;
  }
}

function Fields({
  snapshot,
  target,
  onClose,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  target: EventTarget;
  onClose: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const existing =
    target.kind === 'existing'
      ? snapshot.events.find((event) => event.id === target.eventId)
      : undefined;
  const place =
    existing?.place_id == null
      ? undefined
      : snapshot.places.find((row) => row.id === existing.place_id);

  const [label, setLabel] = useState(existing?.label ?? '');
  const [date, setDate] = useState(
    existing?.local_date ?? (target.kind === 'new' ? target.date : (snapshot.trip.dates[0] ?? '')),
  );
  const [start, setStart] = useState(
    inputFromMinute(existing?.start_minute ?? (target.kind === 'new' ? target.startMinute : 600)),
  );
  const [end, setEnd] = useState(
    inputFromMinute(
      existing?.end_minute ?? (target.kind === 'new' ? target.startMinute + 90 : 690),
    ),
  );
  const [price, setPrice] = useState(
    existing?.price_cents == null ? '' : String(existing.price_cents / 100),
  );
  const [venue, setVenue] = useState(place?.label ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const startMinute = minuteFromInput(start);
    const endMinute = minuteFromInput(end);
    if (label.trim().length === 0) return setProblem('Give it a name.');
    if (startMinute === null || endMinute === null) return setProblem('Use times like 14:30.');
    if (endMinute <= startMinute) return setProblem('It has to end after it starts.');

    const priceCents = price.trim() === '' ? null : Math.round(Number(price) * 100);
    if (priceCents !== null && (!Number.isFinite(priceCents) || priceCents < 0)) {
      return setProblem('That price is not a number.');
    }

    setProblem(null);
    setBusy(true);
    const envelope = {
      idempotency_key: commandKey('event'),
      expected_calendar_version: snapshot.calendar_version,
    };
    // A price a person typed is one a person stands behind.
    const priceFields = {
      price_cents: priceCents,
      price_source: priceCents === null ? null : ('confirmed' as const),
    };
    const named = venue.trim();

    const work =
      existing === undefined
        ? api.createEvent(snapshot.trip.id, {
            ...envelope,
            label: label.trim(),
            local_date: date,
            start_minute: startMinute,
            end_minute: endMinute,
            ...priceFields,
            place: named === '' ? null : { kind: 'manual', label: named },
          })
        : api.patchEvent(snapshot.trip.id, existing.id, {
            ...envelope,
            label: label.trim(),
            local_date: date,
            start_minute: startMinute,
            end_minute: endMinute,
            ...priceFields,
            ...(place === undefined && named !== ''
              ? { place: { kind: 'manual' as const, label: named } }
              : {}),
          });

    void work
      .then(() => {
        onChanged();
        onClose();
      }, onError)
      .finally(() => setBusy(false));
  };

  const remove = (): void => {
    if (existing === undefined) return;
    setBusy(true);
    void api
      .deleteEvent(snapshot.trip.id, existing.id, {
        idempotency_key: commandKey('delete'),
        expected_calendar_version: snapshot.calendar_version,
      })
      .then(() => {
        onChanged();
        onClose();
      }, onError)
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit} className="grid gap-2.5 border-t border-stone-200 pt-3">
      <Field label="What">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={120}
          placeholder="Carnegie Museum of Art"
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-3 gap-2">
        <Field label="Day">
          <select value={date} onChange={(e) => setDate(e.target.value)} className={inputClass}>
            {snapshot.trip.dates.map((day) => (
              <option key={day} value={day}>
                {dayLabel(day)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="To">
          <input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Where">
          <input
            value={venue}
            onChange={(event) => setVenue(event.target.value)}
            disabled={place !== undefined}
            placeholder="optional"
            className={inputClass}
          />
        </Field>
        <Field label="Each ($)">
          <input
            type="number"
            min={0}
            step={1}
            value={price}
            placeholder="unknown"
            onChange={(event) => setPrice(event.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      {place !== undefined && (
        <VenueFields
          snapshot={snapshot}
          place={place}
          date={date}
          onChanged={onChanged}
          onError={onError}
        />
      )}

      {existing?.schedule_locked_by_human === true && (
        <p className="text-[11px] text-stone-500">
          A person set this time, so automatic planning will not move it.
        </p>
      )}
      {problem !== null && <p className="text-xs text-red-700">{problem}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-stone-800 px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {existing === undefined ? 'Add to plan' : 'Save'}
        </button>
        {existing !== undefined && (
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            aria-label="Remove from plan"
            className="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 aria-hidden className="size-4" />
            Remove
          </button>
        )}
      </div>
    </form>
  );
}

const inputClass =
  'w-full rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-stone-900 focus:border-stone-500 focus:outline-none disabled:bg-stone-100 disabled:text-stone-500';

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="grid gap-1 text-[11px] font-medium tracking-wide text-stone-500 uppercase">
      {label}
      {children}
    </label>
  );
}

function Panel({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div
      role="dialog"
      aria-modal
      aria-label={title}
      className="fixed inset-0 z-30 flex items-end justify-center bg-stone-900/25 p-3 sm:items-center"
    >
      <div className="grid max-h-[88vh] w-full max-w-md gap-3 overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-stone-900">{title}</h2>
            {subtitle !== undefined && <p className="text-xs text-stone-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 shrink-0 place-items-center rounded-full text-stone-400 hover:bg-stone-100"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
