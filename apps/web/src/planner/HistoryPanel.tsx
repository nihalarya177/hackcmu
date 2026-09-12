import { useState } from 'react';
import type { SnapshotResponse } from '@trip/contracts';
import { useAdapter } from '../adapter/context';
import { clock, commandKey, dayLabel } from './format';

/** Recently deleted events, with a way to put one back. */
export function HistoryPanel({
  snapshot,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement | null {
  const adapter = useAdapter();
  const [busy, setBusy] = useState<string | null>(null);
  if (snapshot.recent_deletions.length === 0) return null;

  const restore = (eventId: string): void => {
    setBusy(eventId);
    void adapter
      .restoreEvent(snapshot.trip.id, eventId, {
        idempotency_key: commandKey('restore'),
        expected_calendar_version: snapshot.calendar_version,
      })
      .then(onChanged, onError)
      .finally(() => setBusy(null));
  };

  return (
    <div>
      <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
        Recently removed
      </h2>
      <ul className="mt-2 grid gap-1">
        {snapshot.recent_deletions.map((deleted) => (
          <li
            key={deleted.event_id}
            className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"
          >
            <span className="min-w-0">
              <span className="block truncate text-slate-700">{deleted.label}</span>
              <span className="text-slate-500">
                {dayLabel(deleted.local_date)} {clock(deleted.start_minute)}
                {deleted.reason === 'auto_zero_attendance' && ' · nobody was going'}
              </span>
            </span>
            {adapter.capabilities.eventRestore && (
              <button
                type="button"
                disabled={busy === deleted.event_id}
                onClick={() => restore(deleted.event_id)}
                className="shrink-0 text-slate-700 underline disabled:opacity-50"
              >
                Restore
              </button>
            )}
          </li>
        ))}
      </ul>
      {snapshot.has_more_deletions && (
        <p className="mt-1 text-xs text-slate-500">Older removals are not shown.</p>
      )}
    </div>
  );
}
