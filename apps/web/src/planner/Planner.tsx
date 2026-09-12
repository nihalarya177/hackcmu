import { useCallback, useState } from 'react';
import { CalendarDays, History, Link2, Map as MapIcon } from 'lucide-react';
import type { SnapshotResponse } from '@trip/contracts';
import { ApiRequestError, api } from '../lib/api';
import { BudgetRail } from './BudgetRail';
import { Conversation } from './Conversation';
import { EventDetail, type EventTarget, describeWarning } from './EventDetail';
import { PlanCalendar } from './PlanCalendar';
import { PlanMap } from './PlanMap';
import { clock, commandKey, dayLabel, initials } from './format';
import { useMessages, useRefresh, useSnapshot, useTripRealtime } from './queries';

type View = 'calendar' | 'map';

/**
 * The planning screen: the conversation on the left, what it has produced on
 * the right. Talking is the primary action, and the plan is what falls out of
 * it, so the two are always on screen together on a wide display.
 */
export function Planner({ tripId }: { tripId: string }): React.ReactElement {
  const snapshot = useSnapshot(tripId);
  const messages = useMessages(tripId);
  const refresh = useRefresh(tripId);
  useTripRealtime(tripId);

  const [view, setView] = useState<View>('calendar');
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState<EventTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const onChanged = useCallback(() => {
    setNotice(null);
    void refresh();
  }, [refresh]);

  const onError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiRequestError && error.code === 'STALE_VERSION') {
        // Somebody else moved first. Take their version; never replay over it.
        setNotice('The plan changed while you were editing, so this view was refreshed.');
        void refresh();
        return;
      }
      setNotice(error instanceof Error ? error.message : 'Something went wrong.');
    },
    [refresh],
  );

  if (snapshot.isPending) {
    return <Centered>Loading the trip…</Centered>;
  }
  if (snapshot.isError || snapshot.data === undefined) {
    return (
      <Centered>
        <p className="text-sm text-red-800">
          {snapshot.error instanceof Error ? snapshot.error.message : 'Could not load the trip.'}
        </p>
        <button
          type="button"
          onClick={() => void snapshot.refetch()}
          className="mt-3 rounded-lg bg-stone-800 px-3.5 py-2 text-sm text-white"
        >
          Try again
        </button>
      </Centered>
    );
  }

  const data = snapshot.data;

  return (
    <div className="flex h-screen flex-col bg-stone-50">
      <TopBar snapshot={data} onError={onError} />

      <div className="border-b border-stone-200 bg-stone-50 px-4 py-2">
        <BudgetRail snapshot={data} onChanged={onChanged} onError={onError} />
      </div>

      {notice !== null && (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900">
          {notice}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section className="flex min-h-0 flex-1 flex-col border-stone-200 px-4 pb-3 md:max-w-[46%] md:border-r">
          <Conversation
            snapshot={data}
            messages={messages.data}
            loading={messages.isPending}
            draft={draft}
            onDraft={setDraft}
            onChanged={onChanged}
            onError={onError}
          />
        </section>

        <section className="flex min-h-0 flex-1 flex-col gap-2 px-4 pt-2 pb-3">
          <div className="flex items-center gap-1">
            <ViewTab
              active={view === 'calendar'}
              onClick={() => setView('calendar')}
              icon={CalendarDays}
            >
              Calendar
            </ViewTab>
            <ViewTab active={view === 'map'} onClick={() => setView('map')} icon={MapIcon}>
              Map
            </ViewTab>
            {data.recent_deletions.length > 0 && (
              <button
                type="button"
                onClick={() => setShowHistory((value) => !value)}
                aria-pressed={showHistory}
                className="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-stone-500 hover:bg-stone-100"
              >
                <History aria-hidden className="size-3.5" />
                Removed ({data.recent_deletions.length})
              </button>
            )}
          </div>

          {showHistory && <RemovedList snapshot={data} onChanged={onChanged} onError={onError} />}

          <Warnings snapshot={data} />

          {view === 'calendar' ? (
            <PlanCalendar
              snapshot={data}
              onOpenEvent={(eventId) => setTarget({ kind: 'existing', eventId })}
              onPickSlot={(date, startMinute) => setTarget({ kind: 'new', date, startMinute })}
            />
          ) : (
            <PlanMap
              snapshot={data}
              onOpenEvent={(eventId) => setTarget({ kind: 'existing', eventId })}
            />
          )}
        </section>
      </div>

      {target !== null && (
        <EventDetail
          snapshot={data}
          target={target}
          onClose={() => setTarget(null)}
          onChanged={onChanged}
          onError={onError}
        />
      )}
    </div>
  );
}

function TopBar({
  snapshot,
  onError,
}: {
  snapshot: SnapshotResponse;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const isCreator = snapshot.self_person_id === snapshot.trip.creator_person_id;

  const share = (): void => {
    void api
      .mintInvite(snapshot.trip.id, { idempotency_key: commandKey('invite'), rotate: false })
      .then((result) => {
        const url = `${window.location.origin}/?invite=${result.invite.token}`;
        void navigator.clipboard.writeText(url).then(
          () => setCopied(true),
          // The link is still minted; say so rather than pretending it copied.
          () => onError(new Error(`Invite link: ${url}`)),
        );
      }, onError);
  };

  return (
    <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-2.5">
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold text-stone-900">{snapshot.trip.trip_name}</h1>
        <p className="truncate text-[11px] text-stone-500">
          {snapshot.trip.destination_label} · {dayLabel(snapshot.trip.start_date)} –{' '}
          {dayLabel(snapshot.trip.end_date)}
        </p>
      </div>

      <ul className="ml-auto flex -space-x-1.5">
        {snapshot.members.map((person) => (
          <li
            key={person.id}
            title={person.display_name}
            className="grid size-7 place-items-center rounded-full text-[10px] font-semibold text-white ring-2 ring-white"
            style={{ backgroundColor: person.color }}
          >
            {initials(person.display_name)}
          </li>
        ))}
      </ul>

      {isCreator && (
        <button
          type="button"
          onClick={share}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-stone-300 px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50"
        >
          <Link2 aria-hidden className="size-3.5" />
          {copied ? 'Link copied' : 'Invite'}
        </button>
      )}
    </header>
  );
}

function Warnings({ snapshot }: { snapshot: SnapshotResponse }): React.ReactElement | null {
  const names = new Map(snapshot.members.map((person) => [person.id, person.display_name]));
  const active = snapshot.warnings.filter((warning) => warning.active);
  if (active.length === 0) return null;

  return (
    <ul className="grid gap-1">
      {active.slice(0, 4).map((warning) => (
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

function RemovedList({
  snapshot,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);

  const restore = (eventId: string): void => {
    setBusy(eventId);
    void api
      .restoreEvent(snapshot.trip.id, eventId, {
        idempotency_key: commandKey('restore'),
        expected_calendar_version: snapshot.calendar_version,
      })
      .then(onChanged, onError)
      .finally(() => setBusy(null));
  };

  return (
    <ul className="grid gap-1 rounded-xl border border-stone-200 bg-white p-2">
      {snapshot.recent_deletions.map((removed) => (
        <li key={removed.event_id} className="flex items-center gap-2 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-stone-700">
            {removed.label}
            <span className="text-stone-400">
              {' '}
              · {dayLabel(removed.local_date)} {clock(removed.start_minute)}
              {removed.reason === 'auto_zero_attendance' && ' · nobody was going'}
            </span>
          </span>
          <button
            type="button"
            disabled={busy === removed.event_id}
            onClick={() => restore(removed.event_id)}
            className="shrink-0 text-stone-700 underline disabled:opacity-50"
          >
            Put back
          </button>
        </li>
      ))}
    </ul>
  );
}

function ViewTab({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof CalendarDays;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
        active ? 'bg-stone-800 text-white' : 'text-stone-600 hover:bg-stone-100'
      }`}
    >
      <Icon aria-hidden className="size-3.5" />
      {children}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="grid h-screen place-items-center bg-stone-50 p-6 text-center">
      <div className="text-sm text-stone-500">{children}</div>
    </div>
  );
}
