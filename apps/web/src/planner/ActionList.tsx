import { useState } from 'react';
import type { BotActionResource, SnapshotResponse } from '@trip/contracts';
import { useAdapter } from '../adapter/context';
import { commandKey } from './format';

/**
 * Stored Remove/Keep and Undo notices.
 *
 * Which buttons appear comes from the server's `available_choices`, never from
 * a client-side map of action type to buttons. An action whose event has moved
 * on since it was stored resolves as stale and changes nothing.
 */
/** The accessible name is the visible word, not a CSS-capitalised value. */
const CHOICE_LABELS = { remove: 'Remove', keep: 'Keep', undo: 'Undo' } as const;

export function ActionList({
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
  if (!adapter.capabilities.botActions) return null;

  const pending = snapshot.actions.filter((action) => action.status === 'pending');
  const recent = snapshot.actions.filter((action) => action.status !== 'pending').slice(-2);
  if (pending.length === 0 && recent.length === 0) return null;

  const resolve = (action: BotActionResource, choice: 'remove' | 'keep' | 'undo'): void => {
    setBusy(action.id);
    void adapter
      .resolveAction(snapshot.trip.id, action.id, {
        idempotency_key: commandKey('action'),
        expected_calendar_version: snapshot.calendar_version,
        choice,
      })
      .then((result) => {
        if (result.status === 'stale') {
          onError(new Error('That suggestion referred to an older version of the event.'));
          return;
        }
        onChanged();
      }, onError)
      .finally(() => setBusy(null));
  };

  return (
    <ul className="grid gap-2">
      {pending.map((action) => (
        <li
          key={action.id}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <span className="text-slate-700">{describe(action, snapshot)}</span>
          <span className="ml-auto flex gap-2">
            {action.available_choices.map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={busy === action.id}
                onClick={() => resolve(action, choice)}
                className={`rounded-md px-3 py-1 text-sm disabled:opacity-50 ${
                  choice === 'remove'
                    ? 'bg-red-700 text-white'
                    : 'border border-slate-300 bg-white text-slate-800'
                }`}
              >
                {CHOICE_LABELS[choice]}
              </button>
            ))}
          </span>
        </li>
      ))}

      {recent.map((action) => (
        <li key={action.id} className="px-1 text-xs text-slate-500">
          {describe(action, snapshot)} — {resolution(action, snapshot)}
        </li>
      ))}
    </ul>
  );
}

function describe(action: BotActionResource, snapshot: SnapshotResponse): string {
  const label =
    snapshot.events.find((event) => event.id === action.target_event_id)?.label ??
    snapshot.recent_deletions.find((row) => row.event_id === action.target_event_id)?.label ??
    'an event';
  return action.type === 'remove_suggestion' ? `Drop ${label}?` : `${label} was brought back.`;
}

function resolution(action: BotActionResource, snapshot: SnapshotResponse): string {
  const who =
    snapshot.members.find((person) => person.id === action.resolved_by_person_id)?.display_name ??
    'someone';
  if (action.status === 'stale') return 'no longer applies';
  return action.status === 'applied' ? `actioned by ${who}` : `kept by ${who}`;
}
