import { useState } from 'react';
import type { SelfAttendanceChoice, SnapshotResponse } from '@trip/contracts';
import { useAdapter } from '../adapter/context';
import { clock, commandKey, dayLabel, inputFromMinute, minuteFromInput } from './format';
import { VenueCorrection } from './VenueCorrection';

type Mode = { kind: 'create' } | { kind: 'edit'; eventId: string };

/**
 * One dialog for adding an event, editing its shared details, setting your own
 * attendance and deleting it. Attendance is self-only: there is no control here
 * for anyone else's choice, because no endpoint would accept one.
 */
export function EventDialog({
  snapshot,
  mode,
  onClose,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  mode: Mode;
  onClose: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement | null {
  const adapter = useAdapter();
  const existing =
    mode.kind === 'edit' ? snapshot.events.find((event) => event.id === mode.eventId) : undefined;

  // The event vanished underneath the dialog — a deletion, or someone else's
  // edit landing between the click and the render.
  if (mode.kind === 'edit' && existing === undefined) {
    return (
      <Shell title="That event is gone" onClose={onClose}>
        <p className="text-sm text-slate-600">
          It was deleted or changed while this was open. Close and take another look.
        </p>
      </Shell>
    );
  }

  return (
    <Shell
      title={existing === undefined ? 'Add an event' : existing.label}
      onClose={onClose}
      subtitle={
        existing === undefined
          ? undefined
          : `${dayLabel(existing.local_date)} · ${clock(existing.start_minute)} – ${clock(existing.end_minute)}`
      }
    >
      {existing !== undefined && (
        <>
          <Attendance
            snapshot={snapshot}
            eventId={existing.id}
            onChanged={onChanged}
            onError={onError}
          />
          <Roster snapshot={snapshot} eventId={existing.id} />
          {existing.place_id !== null && (
            <Venue snapshot={snapshot} event={existing} onChanged={onChanged} onError={onError} />
          )}
        </>
      )}

      {adapter.capabilities.manualEvents ? (
        <EventFields
          snapshot={snapshot}
          mode={mode}
          onClose={onClose}
          onChanged={onChanged}
          onError={onError}
        />
      ) : (
        <p className="rounded-lg bg-slate-100 p-3 text-xs text-slate-600">
          Editing events is not available in {adapter.mode} mode yet.
        </p>
      )}
    </Shell>
  );
}

const ATTENDANCE_LABELS: Record<SelfAttendanceChoice, string> = {
  in: 'Going',
  out: 'Not going',
  undecided: 'Undecided',
};

function Attendance({
  snapshot,
  eventId,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  eventId: string;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement | null {
  const adapter = useAdapter();
  const [busy, setBusy] = useState(false);
  if (!adapter.capabilities.selfAttendance) return null;

  const mine = snapshot.attendance.find(
    (row) => row.event_id === eventId && row.person_id === snapshot.self_person_id,
  );
  const current: SelfAttendanceChoice = mine?.state ?? 'undecided';

  const choose = (choice: SelfAttendanceChoice): void => {
    setBusy(true);
    void adapter
      .setSelfAttendance(snapshot.trip.id, eventId, {
        idempotency_key: commandKey('attend'),
        expected_calendar_version: snapshot.calendar_version,
        state: choice,
      })
      .then(onChanged, onError)
      .finally(() => setBusy(false));
  };

  return (
    <fieldset disabled={busy} className="grid gap-1">
      <legend className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
        Are you going?
      </legend>
      <div className="flex gap-2">
        {(['in', 'out', 'undecided'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={current === choice}
            onClick={() => choose(choice)}
            className={`rounded-full border px-3 py-1 text-sm ${
              current === choice
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 bg-white text-slate-700'
            } disabled:opacity-50`}
          >
            {ATTENDANCE_LABELS[choice]}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        If everyone leaves, the event is removed from the calendar.
      </p>
    </fieldset>
  );
}

function Roster({
  snapshot,
  eventId,
}: {
  snapshot: SnapshotResponse;
  eventId: string;
}): React.ReactElement {
  const going = snapshot.attendance
    .filter((row) => row.event_id === eventId && row.state === 'in')
    .map((row) => snapshot.members.find((person) => person.id === row.person_id))
    .filter((person) => person !== undefined);

  return (
    <div>
      <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Going</h3>
      {going.length === 0 ? (
        <p className="text-sm text-slate-500">Nobody yet.</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-2">
          {going.map((person) => (
            <li
              key={person.id}
              className="flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-sm text-slate-700"
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
      )}
    </div>
  );
}

function Venue({
  snapshot,
  event,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  event: SnapshotResponse['events'][number];
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement | null {
  const place = snapshot.places.find((row) => row.id === event.place_id);
  if (place === undefined) return null;
  return (
    <VenueCorrection
      snapshot={snapshot}
      place={place}
      date={event.local_date}
      onChanged={onChanged}
      onError={onError}
    />
  );
}

function EventFields({
  snapshot,
  mode,
  onClose,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  mode: Mode;
  onClose: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const adapter = useAdapter();
  const existing =
    mode.kind === 'edit' ? snapshot.events.find((event) => event.id === mode.eventId) : undefined;

  const [label, setLabel] = useState(existing?.label ?? '');
  const [date, setDate] = useState(existing?.local_date ?? snapshot.trip.dates[0] ?? '');
  const [start, setStart] = useState(inputFromMinute(existing?.start_minute ?? 600));
  const [end, setEnd] = useState(inputFromMinute(existing?.end_minute ?? 690));
  const [price, setPrice] = useState(
    existing?.price_cents === null || existing?.price_cents === undefined
      ? ''
      : String(existing.price_cents / 100),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const startMinute = minuteFromInput(start);
    const endMinute = minuteFromInput(end);
    if (label.trim().length === 0) return setProblem('Give the event a name.');
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
    const request =
      existing === undefined
        ? adapter.createEvent(snapshot.trip.id, {
            ...envelope,
            label: label.trim(),
            local_date: date,
            start_minute: startMinute,
            end_minute: endMinute,
            price_cents: priceCents,
            // A price a person typed is one a person stands behind.
            price_source: priceCents === null ? null : 'confirmed',
            place: null,
          })
        : adapter.patchEvent(snapshot.trip.id, existing.id, {
            ...envelope,
            label: label.trim(),
            local_date: date,
            start_minute: startMinute,
            end_minute: endMinute,
            price_cents: priceCents,
            price_source: priceCents === null ? null : 'confirmed',
          });

    void request
      .then(() => {
        onChanged();
        onClose();
      }, onError)
      .finally(() => setBusy(false));
  };

  const remove = (): void => {
    if (existing === undefined) return;
    setBusy(true);
    void adapter
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
    <form onSubmit={submit} className="grid gap-3 border-t border-slate-200 pt-4">
      <label className="grid gap-1 text-xs text-slate-600">
        Name
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={120}
          className="rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
        />
      </label>

      <div className="grid grid-cols-3 gap-2">
        <label className="grid gap-1 text-xs text-slate-600">
          Day
          <select
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
          >
            {snapshot.trip.dates.map((day) => (
              <option key={day} value={day}>
                {dayLabel(day)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-slate-600">
          Start
          <input
            type="time"
            value={start}
            onChange={(event) => setStart(event.target.value)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
          />
        </label>
        <label className="grid gap-1 text-xs text-slate-600">
          End
          <input
            type="time"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
          />
        </label>
      </div>

      <label className="grid gap-1 text-xs text-slate-600">
        Price per person (leave blank if unknown)
        <input
          type="number"
          min={0}
          step={1}
          value={price}
          placeholder="unknown"
          onChange={(event) => setPrice(event.target.value)}
          className="w-32 rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
        />
      </label>

      {existing?.schedule_locked_by_human === true && (
        <p className="text-xs text-slate-500">
          The time on this event was set by a person, so the planner will not move it.
        </p>
      )}
      {problem !== null && <p className="text-xs text-red-700">{problem}</p>}

      <div className="flex items-center justify-between gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {existing === undefined ? 'Add event' : 'Save changes'}
        </button>
        {existing !== undefined && (
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="text-sm text-red-700 underline disabled:opacity-50"
          >
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

function Shell({
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
      className="fixed inset-0 z-20 flex items-end justify-center bg-slate-900/30 p-4 sm:items-center"
    >
      <div className="grid max-h-[85vh] w-full max-w-md gap-4 overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            {subtitle !== undefined && <p className="text-sm text-slate-600">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="text-sm text-slate-500 underline">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export type { Mode as EventDialogMode };
