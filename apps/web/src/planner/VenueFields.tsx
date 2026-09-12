import { useState } from 'react';
import type { PlaceResource, SnapshotResponse } from '@trip/contracts';
import { api } from '../lib/api';
import { commandKey, inputFromMinute, minuteFromInput } from './format';

/**
 * Correcting a venue by hand: where it is, and whether it is open that day.
 *
 * There is no search provider in this milestone, so a person types the truth
 * and the record says a person did. Nothing automatic overwrites it afterwards.
 */
export function VenueFields({
  snapshot,
  place,
  date,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  place: PlaceResource;
  date: string;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const stored = place.hours_days.find((day) => day.date === date);
  const interval = stored?.intervals[0];

  const [open, setOpen] = useState(false);
  const [lat, setLat] = useState(place.coordinate === null ? '' : String(place.coordinate.lat));
  const [lon, setLon] = useState(place.coordinate === null ? '' : String(place.coordinate.lon));
  const [closed, setClosed] = useState(stored !== undefined && stored.intervals.length === 0);
  const [opens, setOpens] = useState(inputFromMinute(interval?.start_minute ?? 600));
  const [shuts, setShuts] = useState(inputFromMinute(interval?.end_minute ?? 1020));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const hours =
    stored === undefined
      ? 'hours unknown'
      : stored.intervals.length === 0
        ? 'recorded closed'
        : `open ${stored.intervals.map((i) => `${inputFromMinute(i.start_minute)}–${inputFromMinute(i.end_minute)}`).join(', ')}`;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setProblem(null);

    const latitude = lat.trim() === '' ? null : Number(lat);
    const longitude = lon.trim() === '' ? null : Number(lon);
    if ((latitude === null) !== (longitude === null)) {
      return setProblem('Give both a latitude and a longitude, or neither.');
    }
    if (latitude !== null && (!Number.isFinite(latitude) || Math.abs(latitude) > 90)) {
      return setProblem('Latitude has to be between -90 and 90.');
    }
    if (longitude !== null && (!Number.isFinite(longitude) || Math.abs(longitude) > 180)) {
      return setProblem('Longitude has to be between -180 and 180.');
    }

    let intervals: { start_minute: number; end_minute: number }[] = [];
    if (!closed) {
      const from = minuteFromInput(opens);
      const to = minuteFromInput(shuts);
      if (from === null || to === null) return setProblem('Use times like 09:30.');
      if (to <= from) return setProblem('Closing has to be after opening.');
      intervals = [{ start_minute: from, end_minute: to }];
    }

    setBusy(true);
    void api
      .patchPlace(snapshot.trip.id, place.id, {
        idempotency_key: commandKey('place'),
        expected_calendar_version: snapshot.calendar_version,
        choice: {
          kind: 'manual',
          coordinate:
            latitude === null || longitude === null ? null : { lat: latitude, lon: longitude },
          hours_days: [...place.hours_days.filter((day) => day.date !== date), { date, intervals }],
        },
      })
      .then(() => {
        setOpen(false);
        onChanged();
      }, onError)
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-stone-50 px-2.5 py-2 text-[11px] text-stone-600">
        <span className="min-w-0 flex-1 truncate">
          {place.label} · {place.coordinate === null ? 'location unknown' : 'located'} · {hours}
          {place.human_override && ' · corrected by a person'}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 text-stone-700 underline"
        >
          Correct
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-2 rounded-lg bg-stone-50 p-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Small label="Latitude" value={lat} onChange={setLat} />
        <Small label="Longitude" value={lon} onChange={setLon} />
      </div>
      <label className="flex items-center gap-2 text-[11px] text-stone-600">
        <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
        Closed on {date}
      </label>
      {!closed && (
        <div className="grid grid-cols-2 gap-2">
          <Small label="Opens" value={opens} onChange={setOpens} type="time" />
          <Small label="Closes" value={shuts} onChange={setShuts} type="time" />
        </div>
      )}
      {problem !== null && <p className="text-[11px] text-red-700">{problem}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="rounded-md bg-stone-800 px-2.5 py-1 text-[11px] text-white disabled:opacity-50"
        >
          Save correction
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-stone-600 underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Small({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}): React.ReactElement {
  return (
    <label className="grid gap-0.5 text-[10px] tracking-wide text-stone-500 uppercase">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-900"
      />
    </label>
  );
}
