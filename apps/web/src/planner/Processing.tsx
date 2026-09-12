import { useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { BotActionResource, SnapshotResponse } from '@trip/contracts';
import { api } from '../lib/api';
import { commandKey } from './format';

const CHOICE_LABELS = { remove: 'Remove', keep: 'Keep', undo: 'Undo' } as const;

/**
 * "Update plan" and what came back.
 *
 * The button queues durable work and returns; the worker does the reading. So
 * the states shown here are the real ones, including the case where no worker
 * is running at all — a stopped worker must never look healthy.
 */
export function UpdatePlanButton({
  snapshot,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const {
    state,
    worker_available: worker,
    pending_user_message_count: pending,
  } = snapshot.processing;
  const running = state === 'queued' || state === 'running';
  const unavailable = state === 'unavailable' || state === 'disabled' || !worker;

  const run = (): void => {
    setBusy(true);
    void api
      .requestProcessing(snapshot.trip.id, { idempotency_key: commandKey('process') })
      .then(onChanged, onError)
      .finally(() => setBusy(false));
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy || running || unavailable}
      title={
        unavailable
          ? 'No planning worker is running, so the conversation cannot be read right now.'
          : undefined
      }
      className="flex items-center gap-1.5 rounded-lg bg-ink px-2.5 py-1 text-xs font-medium text-white transition disabled:bg-faint"
    >
      <Sparkles aria-hidden className={`size-3.5 ${running ? 'animate-pulse' : ''}`} />
      {running ? 'Reading…' : 'Update plan'}
      {!running && pending > 0 && !unavailable && (
        <span className="rounded-full bg-surface/20 px-1.5 text-[10px]">{pending}</span>
      )}
    </button>
  );
}

/** The pipeline's state in words, including when it is simply not there. */
export function ProcessingNote({
  snapshot,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement | null {
  const { state, last_error_code: code, worker_available: worker } = snapshot.processing;

  const retry = (): void => {
    void api
      .requestProcessing(snapshot.trip.id, { idempotency_key: commandKey('retry') })
      .then(onChanged, onError);
  };

  if (state === 'disabled') {
    return <Note tone="muted">Automatic planning is switched off for this trip.</Note>;
  }
  if (state === 'unavailable' || !worker) {
    return (
      <Note tone="muted">
        No planning worker is running, so nothing is reading the conversation. Manual planning still
        works.
      </Note>
    );
  }
  if (state === 'failed') {
    return (
      <Note tone="bad">
        Reading the conversation failed{code === null ? '' : ` (${code})`}.
        <button
          type="button"
          onClick={retry}
          className="ml-1.5 inline-flex items-center gap-1 underline"
        >
          <RefreshCw aria-hidden className="size-3" />
          Try again
        </button>
      </Note>
    );
  }
  if (state === 'retry_wait') {
    return (
      <Note tone="muted">
        That attempt failed{code === null ? '' : ` (${code})`}; it will try again shortly.
      </Note>
    );
  }
  return null;
}

/**
 * Stored Remove/Keep and Undo notices.
 *
 * Which buttons appear comes from the server's `available_choices`, never from
 * a client-side map of action type to buttons.
 */
export function ActionNotices({
  snapshot,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement | null {
  const [busy, setBusy] = useState<string | null>(null);
  const pending = snapshot.actions.filter((action) => action.status === 'pending');
  if (pending.length === 0) return null;

  const resolve = (action: BotActionResource, choice: 'remove' | 'keep' | 'undo'): void => {
    setBusy(action.id);
    void api
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
    <ul className="grid gap-1">
      {pending.map((action) => (
        <li
          key={action.id}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs"
        >
          <span className="text-ink">{describe(action, snapshot)}</span>
          <span className="ml-auto flex gap-1.5">
            {action.available_choices.map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={busy === action.id}
                onClick={() => resolve(action, choice)}
                className={`rounded-md px-2.5 py-1 font-medium disabled:opacity-50 ${
                  choice === 'remove' ? 'bg-red-700 text-white' : 'border border-hairline text-ink'
                }`}
              >
                {CHOICE_LABELS[choice]}
              </button>
            ))}
          </span>
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
  return action.type === 'remove_suggestion'
    ? `Drop ${label}?`
    : `${label} was brought back — undo that?`;
}

function Note({
  tone,
  children,
}: {
  tone: 'muted' | 'bad';
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <p
      className={`rounded-lg px-2.5 py-1.5 text-[11px] ${
        tone === 'bad'
          ? 'border border-alarm/25 bg-alarm-surface text-alarm-ink'
          : 'bg-sunken text-muted'
      }`}
    >
      {children}
    </p>
  );
}
