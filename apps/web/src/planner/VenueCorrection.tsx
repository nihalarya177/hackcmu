import { useState } from 'react';
import type { PlaceResource, SnapshotResponse } from '@trip/contracts';
import { useAdapter } from '../adapter/context';
import { commandKey, inputFromMinute, minuteFromInput } from './format';

/**
 * Manual venue correction: where it actually is, and whether it is open that
 * day. There is no search provider here, so a person types the truth and the
 * record says a person did.
 */
export function VenueCorrection({
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
  const adapter = useAdapter();
  const stored = place.hours_days.find((day) => day.date === date);
  const firstInterval = stored?.intervals[0];

  const [open, setOpen] = useState(false);
  const [lat, setLat] = useState(place.coordinate === null ? '' : String(place.coordinate.lat));
  const [lon, setLon] = useState(place.coordinate === null ? '' : String(place.coordinate.lon));
  const [closed, setClosed] = useState(stored !== undefined && stored.intervals.length === 0);
  const [opens, setOpens] = useState(inputFromMinute(firstInterval?.start_minute ?? 600));
  const [shuts, setShuts] = useState(inputFromMinute(firstInterval?.end_minute ?? 1020));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const hoursSummary =
    stored === undefined
      ? 'Hours for this day are unknown.'
      : stored.intervals.length === 0
        ? 'Recorded as closed this day.'
        : `Recorded open ${stored.intervals.map((i) => `${inputFromMinute(i.start_minute)}–${inputFromMinute(i.end_minute)}`).join(', ')}.`;

  if (!adapter.capabilities.places) {
    return (
      <p className="text-xs text-slate-500">
        {place.label} · {hoursSummary} Corrections are not available in {adapter.mode} mode.
      </p>
    );
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setProblem(null);

    const latitude = lat.trim() === '' ? null : Number(lat);
    const longitude = lon.trim() === '' ? null : Number(lon);
    if ((latitude === null) !== (longitude === null)) {
      return setProblem('Give both a latitude and a longitude, or neither.');
    }
    if (latitude !== null && longitude !== null) {
      if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) {
        return setProblem('Latitude has to be between -90 and 90.');
      }
      if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) {
        return setProblem('Longitude has to be between -180 and 180.');
      }
    }

    let intervals: { start_minute: number; end_minute: number }[] = [];
    if (!closed) {
      const from = minuteFromInput(opens);
      const to = minuteFromInput(shuts);
      if (from === null || to === null) return setProblem('Use times like 09:30.');
      if (to <= from) return setProblem('Closing time has to be after opening time.');
      intervals = [{ start_minute: from, end_minute: to }];
    }

    setBusy(true);
    void adapter
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

  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <p className="text-xs text-slate-600">
        <span className="font-medium text-slate-800">{place.label}</span>
        {place.coordinate === null && ' · location unknown'}
        {place.human_override && ' · corrected by a person'}
      </p>
      <p className="text-xs text-slate-500">{hoursSummary}</p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-1 text-xs text-slate-700 underline"
        >
          Correct this venue
        </button>
      ) : (
        <form onSubmit={submit} className="mt-2 grid gap-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs text-slate-600">
              Latitude
              <input
                value={lat}
                onChange={(event) => setLat(event.target.value)}
                className="rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="grid gap-1 text-xs text-slate-600">
              Longitude
              <input
                value={lon}
                onChange={(event) => setLon(event.target.value)}
                className="rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={closed}
              onChange={(event) => setClosed(event.target.checked)}
            />
            Closed on this day
          </label>

          {!closed && (
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-xs text-slate-600">
                Opens
                <input
                  type="time"
                  value={opens}
                  onChange={(event) => setOpens(event.target.value)}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="grid gap-1 text-xs text-slate-600">
                Closes
                <input
                  type="time"
                  value={shuts}
                  onChange={(event) => setShuts(event.target.value)}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
            </div>
          )}

          {problem !== null && <p className="text-xs text-red-700">{problem}</p>}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-slate-900 px-3 py-1 text-xs text-white disabled:opacity-50"
            >
              Save correction
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-slate-600 underline"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-slate-500">
            This is recorded as a person's correction and is never overwritten automatically.
          </p>
        </form>
      )}
    </div>
  );
}
