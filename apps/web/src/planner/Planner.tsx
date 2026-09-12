import { useCallback, useState } from 'react';
import {
  CalendarDays,
  Download,
  History,
  Link2,
  Map as MapIcon,
  Plus,
  TriangleAlert,
} from 'lucide-react';
import type { SnapshotResponse } from '@trip/contracts';
import { ApiRequestError, api } from '../lib/api';
import { BudgetRail } from './BudgetRail';
import { Conversation } from './Conversation';
import { EventDetail, type EventTarget, describeWarning } from './EventDetail';
import { PlanCalendar } from './PlanCalendar';
import { PlanMap } from './PlanMap';
import { ActionNotices, ProcessingNote, UpdatePlanButton } from './Processing';
import { AvatarRow } from './Avatar';
import { clock, commandKey, dayLabel } from './format';
import { useMessages, useRefresh, useSnapshot, useTripRealtime } from './queries';

type View = 'calendar' | 'map';

/**
 * The planning screen: the conversation on the left, what it has produced on
 * the right. Talking is the primary action, and the plan is what falls out of
 * it, so the two are always on screen together on a wide display.
 */
export function Planner({
  tripId,
  onUnreachable,
}: {
  tripId: string;
  onUnreachable: () => void;
}): React.ReactElement {
  const snapshot = useSnapshot(tripId);
  const messages = useMessages(tripId);
  const refresh = useRefresh(tripId);
  useTripRealtime(tripId, snapshot.isSuccess);

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
    // A nonmember is told the trip does not exist, so this is also what a
    // browser that lost its anonymous identity sees. Retrying can never help:
    // the identity that joined is gone. Send them back rather than stranding
    // them on a button that will fail forever.
    const unreachable =
      snapshot.error instanceof ApiRequestError && snapshot.error.code === 'NOT_FOUND';

    return (
      <Centered>
        {unreachable ? (
          <>
            <p className="text-sm font-semibold text-ink">
              This browser is no longer part of that trip.
            </p>
            <p className="mt-1 text-sm text-muted">
              Membership belongs to the browser that joined. If you cleared site data, or this is a
              different browser or device, open the invite link again to rejoin.
            </p>
            <button
              type="button"
              onClick={onUnreachable}
              className="mt-4 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white"
            >
              Start over
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-red-800">
              {snapshot.error instanceof Error
                ? snapshot.error.message
                : 'Could not load the trip.'}
            </p>
            <button
              type="button"
              onClick={() => void snapshot.refetch()}
              className="mt-3 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white"
            >
              Try again
            </button>
          </>
        )}
      </Centered>
    );
  }

  const data = snapshot.data;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-ground text-ink">
      <TopBar snapshot={data} onError={onError} />

      <div className="flex min-h-0 flex-1 gap-3.5 px-4.5 pb-4.5 md:flex-row max-md:flex-col">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-[22px] bg-surface md:w-[430px] md:shrink-0">
          <div className="flex min-h-0 flex-1 flex-col px-5 pt-5 pb-4">
            <Conversation
              snapshot={data}
              messages={messages.data}
              loading={messages.isPending}
              draft={draft}
              onDraft={setDraft}
              onChanged={onChanged}
              onError={onError}
            />
          </div>
        </section>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <div className="flex shrink-0 items-center gap-5 rounded-[22px] bg-surface px-4.5 py-3">
            <BudgetRail snapshot={data} onChanged={onChanged} onError={onError} />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <UpdatePlanButton snapshot={data} onChanged={onChanged} onError={onError} />
            </div>
          </div>

          <Alerts snapshot={data} notice={notice} onChanged={onChanged} onError={onError} />

          {showHistory && <RemovedList snapshot={data} onChanged={onChanged} onError={onError} />}

          <div className="flex min-h-0 flex-1 flex-col rounded-[22px] bg-surface px-4.5 py-4">
            <div className="mb-3.5 flex shrink-0 items-center gap-1.5">
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
              <div className="flex-grow" />
              {data.recent_deletions.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHistory((value) => !value)}
                  aria-pressed={showHistory}
                  className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-muted hover:bg-sunken"
                >
                  <History aria-hidden className="size-3.5" />
                  Removed
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  setTarget({ kind: 'new', date: data.trip.dates[0] ?? '', startMinute: 600 })
                }
                className="flex items-center gap-1.5 rounded-full bg-sunken px-3.5 py-1.5 text-[13px] font-semibold"
              >
                <Plus aria-hidden className="size-3.5" />
                Add event
              </button>
            </div>

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
          </div>
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
          // The link is minted either way; say what it is rather than fail.
          () => onError(new Error(`Invite link: ${url}`)),
        );
      }, onError);
  };

  return (
    <header className="flex shrink-0 items-center gap-4 px-4.5 py-3.5">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="truncate text-xl font-extrabold tracking-tight">
          {snapshot.trip.trip_name}
        </h1>
        <p className="hidden shrink-0 text-[13px] font-medium text-muted sm:block">
          {dayLabel(snapshot.trip.start_date)} to {dayLabel(snapshot.trip.end_date)}
        </p>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        <AvatarRow people={snapshot.members} size={30} ring="#f4f3f7" label="Members" />
        {isCreator && (
          <button
            type="button"
            onClick={share}
            className="flex items-center gap-1.5 rounded-full bg-surface px-4 py-2.5 text-[13px] font-semibold"
          >
            <Link2 aria-hidden className="size-[15px]" />
            {copied ? 'Link copied' : 'Invite link'}
          </button>
        )}
        <a
          href={`/api/trips/${snapshot.trip.id}/export.ics`}
          className="flex items-center gap-1.5 rounded-full bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink"
        >
          <Download aria-hidden className="size-[15px]" />
          Export itinerary
        </a>
      </div>
    </header>
  );
}

/**
 * Warnings, and anything the last action needs to say, on one shelf.
 *
 * They stack: a trip can be over budget, double booked and short of travel
 * time at once, and a badge in a corner can only ever show one of those.
 */
function Alerts({
  snapshot,
  notice,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  notice: string | null;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  const names = new Map(
    snapshot.members.map((person) => [
      person.id,
      person.id === snapshot.self_person_id ? 'You' : person.display_name,
    ]),
  );
  const active = snapshot.warnings.filter((warning) => warning.active);
  const pendingActions = snapshot.actions.filter((action) => action.status === 'pending');

  const quiet =
    snapshot.processing.state === 'idle' ||
    snapshot.processing.state === 'queued' ||
    snapshot.processing.state === 'running';
  if (active.length === 0 && notice === null && pendingActions.length === 0 && quiet) {
    return null;
  }

  const shown = expanded ? active : active.slice(0, 2);
  const hidden = active.length - shown.length;

  return (
    <div className="flex shrink-0 flex-col gap-2">
      {(active.length > 0 || notice !== null) && (
        <div className="flex flex-col gap-2 rounded-[18px] bg-alarm-surface px-4 py-3">
          {notice !== null && <p className="text-[13px] leading-snug text-alarm-ink">{notice}</p>}
          {shown.map((warning) => (
            <p key={warning.key} className="flex items-start gap-2.5">
              <TriangleAlert aria-hidden className="mt-px size-[15px] shrink-0 text-alarm" />
              <span className="text-[13px] leading-snug text-alarm-ink">
                {describeWarning(warning, names, snapshot)}
              </span>
            </p>
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="self-start pl-[25px] text-[13px] text-alarm-ink/75 underline"
            >
              {hidden} more
            </button>
          )}
        </div>
      )}
      <ProcessingNote snapshot={snapshot} onChanged={onChanged} onError={onError} />
      <ActionNotices snapshot={snapshot} onChanged={onChanged} onError={onError} />
    </div>
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
    <ul className="grid shrink-0 gap-1 rounded-[18px] bg-surface px-4 py-3">
      {snapshot.recent_deletions.map((removed) => (
        <li key={removed.event_id} className="flex items-center gap-2 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-muted">
            {removed.label}
            <span className="text-faint">
              {' '}
              · {dayLabel(removed.local_date)} {clock(removed.start_minute)}
              {removed.reason === 'auto_zero_attendance' && ' · nobody was going'}
            </span>
          </span>
          <button
            type="button"
            disabled={busy === removed.event_id}
            onClick={() => restore(removed.event_id)}
            className="shrink-0 font-semibold text-ink underline disabled:opacity-50"
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
      className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition ${
        active ? 'bg-sunken text-ink' : 'text-muted hover:bg-sunken/60'
      }`}
    >
      <Icon aria-hidden className="size-3.5" />
      {children}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="grid h-screen place-items-center bg-ground p-6 text-center">
      <div className="text-sm text-muted">{children}</div>
    </div>
  );
}
