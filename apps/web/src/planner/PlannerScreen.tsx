import { useCallback, useEffect, useState } from 'react';
import {
  CalendarDays,
  Download,
  Map,
  MessagesSquare,
  Plus,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import type { SnapshotResponse } from '@trip/contracts';
import { useAdapter } from '../adapter/context';
import { ApiRequestError, UnsupportedOperationError } from '../lib/apiError';
import { ActionList } from './ActionList';
import { BudgetPanel } from './BudgetPanel';
import { CalendarPanel } from './CalendarPanel';
import { ChatPanel } from './ChatPanel';
import { EventDialog, type EventDialogMode } from './EventDialog';
import { HistoryPanel } from './HistoryPanel';
import { MapPanel } from './MapPanel';
import { commandKey } from './format';
import { useDemoInvalidation, useMessages, useRefreshPlanner, useSnapshot } from './usePlanner';

type Tab = 'chat' | 'calendar' | 'map';

/** Visible words, so the accessible name is not a CSS transform. */
const TAB_LABELS: Record<Tab, string> = { chat: 'Chat', calendar: 'Calendar', map: 'Map' };

/**
 * The planner itself: budgets down the left, chat and calendar side by side on
 * a wide screen and behind a tab on a narrow one.
 *
 * Both tabs stay mounted, so an unsent draft and the calendar's scroll position
 * survive moving between them.
 */
export function PlannerScreen({ tripId }: { tripId: string }): React.ReactElement {
  const adapter = useAdapter();
  const snapshot = useSnapshot(tripId);
  const messages = useMessages(tripId);
  const refresh = useRefreshPlanner(tripId);
  useDemoInvalidation(tripId);

  const [tab, setTab] = useState<Tab>('chat');
  const [draft, setDraft] = useState('');
  const [dialog, setDialog] = useState<EventDialogMode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const onChanged = useCallback(() => {
    setNotice(null);
    void refresh();
  }, [refresh]);

  const onError = useCallback(
    (error: unknown) => {
      if (error instanceof UnsupportedOperationError) {
        setNotice(error.message);
        return;
      }
      if (error instanceof ApiRequestError && error.code === 'STALE_VERSION') {
        // Someone else moved first. Take their version rather than replaying.
        setNotice('The plan changed while you were editing, so this view was refreshed.');
        void refresh();
        return;
      }
      setNotice(error instanceof Error ? error.message : 'Something went wrong.');
    },
    [refresh],
  );

  if (snapshot.isPending) {
    return <p className="p-6 text-sm text-slate-500">Loading the trip…</p>;
  }
  if (snapshot.isError || snapshot.data === undefined) {
    return (
      <div className="grid gap-3 p-6">
        <p className="text-sm text-red-800">
          {snapshot.error instanceof Error ? snapshot.error.message : 'Could not load the trip.'}
        </p>
        <button
          type="button"
          onClick={() => void snapshot.refetch()}
          className="justify-self-start rounded-lg bg-slate-900 px-4 py-2 text-sm text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  const data = snapshot.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      <div className="grid min-h-0 gap-4 overflow-y-auto md:w-72 md:shrink-0">
        <BudgetPanel snapshot={data} onChanged={onChanged} onError={onError} />
        <HistoryPanel snapshot={data} onChanged={onChanged} onError={onError} />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <Toolbar
          snapshot={data}
          tab={tab}
          onTab={setTab}
          onAdd={() => setDialog({ kind: 'create' })}
          onChanged={onChanged}
          onError={onError}
        />

        <ActionList snapshot={data} onChanged={onChanged} onError={onError} />

        {notice !== null && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {notice}
          </p>
        )}

        {/* Side by side on a wide screen; one at a time behind the tabs on a
            narrow one. Both stay mounted, so the draft and the calendar's
            scroll position survive switching. */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          <div
            className={`flex min-h-0 flex-col md:min-w-0 md:flex-1 ${tab === 'chat' ? 'flex-1' : 'hidden'} md:flex`}
          >
            <ChatPanel
              snapshot={data}
              messages={messages.data}
              loading={messages.isPending}
              draft={draft}
              onDraftChange={setDraft}
              onChanged={onChanged}
              onError={onError}
            />
          </div>
          <div
            className={`flex min-h-0 flex-col md:min-w-0 md:flex-1 ${tab === 'calendar' ? 'flex-1' : 'hidden'} ${tab === 'map' ? 'md:hidden' : 'md:flex'}`}
          >
            <CalendarPanel
              snapshot={data}
              onSelectEvent={(eventId) => setDialog({ kind: 'edit', eventId })}
            />
          </div>
          {/* The map replaces the calendar column rather than crowding it, and
              chat stays put so the conversation is never lost. */}
          <div
            className={`flex min-h-0 flex-col md:min-w-0 ${tab === 'map' ? 'flex-1 md:flex md:flex-1' : 'hidden'}`}
          >
            <MapPanel snapshot={data} />
          </div>
        </div>
      </div>

      {dialog !== null && (
        <EventDialog
          snapshot={data}
          mode={dialog}
          onClose={() => setDialog(null)}
          onChanged={onChanged}
          onError={onError}
        />
      )}

      {adapter.demo !== null && <DemoBar snapshot={data} />}
    </div>
  );
}

function Toolbar({
  snapshot,
  tab,
  onTab,
  onAdd,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onAdd: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const adapter = useAdapter();
  const processing = snapshot.processing;
  const busy = processing.state === 'queued' || processing.state === 'running';

  const update = (): void => {
    void adapter
      .requestProcessing(snapshot.trip.id, { idempotency_key: commandKey('update') })
      .then(onChanged, onError);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex rounded-lg border border-slate-300 p-0.5">
        {(['chat', 'calendar', 'map'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => onTab(name)}
            aria-pressed={tab === name}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-sm ${
              tab === name ? 'bg-slate-900 text-white' : 'text-slate-700'
            }`}
          >
            {name === 'chat' ? (
              <MessagesSquare aria-hidden className="size-4" />
            ) : name === 'calendar' ? (
              <CalendarDays aria-hidden className="size-4" />
            ) : (
              <Map aria-hidden className="size-4" />
            )}
            {TAB_LABELS[name]}
          </button>
        ))}
      </div>

      {adapter.capabilities.requestProcessing && (
        <button
          type="button"
          onClick={update}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          <Sparkles aria-hidden className="size-4" />
          {busy ? 'Working…' : 'Update plan'}
        </button>
      )}

      {adapter.capabilities.manualEvents && (
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800"
        >
          <Plus aria-hidden className="size-4" />
          Add event
        </button>
      )}

      <ExportButton snapshot={snapshot} onError={onError} />

      <ProcessingNote snapshot={snapshot} onRetry={update} />
    </div>
  );
}

/** Downloads the caller's own attended events as a real calendar file. */
function ExportButton({
  snapshot,
  onError,
}: {
  snapshot: SnapshotResponse;
  onError: (error: unknown) => void;
}): React.ReactElement | null {
  const adapter = useAdapter();
  if (!adapter.capabilities.export) return null;

  const download = (): void => {
    void adapter.exportSelfCalendar(snapshot.trip.id).then((file) => {
      const url = URL.createObjectURL(new Blob([file.content], { type: 'text/calendar' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
    }, onError);
  };

  return (
    <button
      type="button"
      onClick={download}
      className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800"
    >
      <Download aria-hidden className="size-4" />
      My calendar
    </button>
  );
}

/** The state of the pipeline, in words, including when it is simply not there. */
function ProcessingNote({
  snapshot,
  onRetry,
}: {
  snapshot: SnapshotResponse;
  onRetry: () => void;
}): React.ReactElement | null {
  const { state, last_error_code: errorCode, worker_available: worker } = snapshot.processing;

  if (state === 'failed') {
    return (
      <span className="text-sm text-red-800">
        Update failed{errorCode === null ? '' : ` (${errorCode})`}.
        <button type="button" onClick={onRetry} className="ml-1 underline">
          Retry
        </button>
      </span>
    );
  }
  if (state === 'unavailable' || !worker) {
    return <span className="text-sm text-slate-500">Automatic planning is unavailable.</span>;
  }
  if (state === 'queued' || state === 'running') {
    return <span className="text-sm text-slate-500">Reading the conversation…</span>;
  }
  return null;
}

/**
 * Named scenarios, for rehearsing without having to type the right words.
 * Pressing one plays exactly what "Update plan" would have played, so the
 * rehearsal and the live demo take the same path.
 */
function ScenarioMenu(): React.ReactElement | null {
  const adapter = useAdapter();
  const demo = adapter.demo;
  const [open, setOpen] = useState(false);
  if (demo === null) return null;
  const scenarios = demo.scenarios();

  return (
    <span className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} className="underline">
        Scenarios
      </button>
      {open && (
        <ul className="absolute bottom-6 left-0 z-20 max-h-72 w-80 overflow-y-auto rounded-lg border border-amber-200 bg-white p-1 shadow-lg">
          {scenarios.map((scenario) => (
            <li key={scenario.id}>
              <button
                type="button"
                disabled={!scenario.eligible}
                onClick={() => {
                  demo.runScenario(scenario.id);
                  setOpen(false);
                }}
                className="w-full rounded px-2 py-1.5 text-left hover:bg-amber-50 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <span className="block text-slate-800">{scenario.title}</span>
                <span className="block text-[11px] text-slate-500">
                  {scenario.applied ? 'already played' : scenario.hint}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

/** Demo-only controls, kept visually apart from the product itself. */
function DemoBar({ snapshot }: { snapshot: SnapshotResponse }): React.ReactElement | null {
  const adapter = useAdapter();
  const demo = adapter.demo;
  const [, bump] = useState(0);
  useEffect(() => demo?.subscribe(() => bump((n) => n + 1)), [demo]);
  if (demo === null) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-amber-200 bg-amber-50/95 px-4 py-2 text-xs text-amber-900">
      <span className="font-semibold">Demo</span>
      <span>acting as</span>
      {snapshot.members.map((person) => (
        <button
          key={person.id}
          type="button"
          onClick={() => demo.switchParticipant(person.id)}
          aria-pressed={person.id === snapshot.self_person_id}
          className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
            person.id === snapshot.self_person_id
              ? 'border-amber-900 bg-amber-900 text-white'
              : 'border-amber-300 bg-white text-amber-900'
          }`}
        >
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: person.color }}
          />
          {person.display_name}
        </button>
      ))}
      <ScenarioMenu />

      <button
        type="button"
        onClick={() => demo.reset()}
        className="ml-auto flex items-center gap-1 underline"
      >
        <RotateCcw aria-hidden className="size-3" />
        Reset demo
      </button>
    </div>
  );
}
