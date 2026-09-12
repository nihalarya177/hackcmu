import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createAdapter, type PlannerAdapter } from './adapter';
import { AdapterProvider } from './adapter/context';
import { browserStorage, resolveInitialMode, writeStoredMode, type Mode } from './mode';
import { Onboarding } from './planner/Onboarding';
import { PlannerScreen } from './planner/PlannerScreen';

/**
 * The planner is the first screen.
 *
 * Demo is the default because it needs no credentials, no API and no database:
 * opening the app must never depend on a backend being reachable. Live is still
 * one explicit choice away, and only then does anything authenticate.
 */
export function App(): React.ReactElement {
  const storage = useMemo(() => browserStorage(), []);
  const [mode, setMode] = useState<Mode>(
    () =>
      resolveInitialMode({ search: window.location.search, storage: browserStorage() }) ?? 'demo',
  );
  const queryClient = useQueryClient();

  const choose = useCallback(
    (next: Mode) => {
      // A mode switch enters a separate namespace; nothing cached under the
      // previous one may survive into it.
      queryClient.clear();
      writeStoredMode(storage, next);
      setMode(next);
    },
    [queryClient, storage],
  );

  return <ModeSession key={mode} mode={mode} onSwitch={choose} />;
}

type Startup = { state: 'starting' } | { state: 'ready' } | { state: 'error'; message: string };

function ModeSession({
  mode,
  onSwitch,
}: {
  mode: Mode;
  onSwitch: (mode: Mode) => void;
}): React.ReactElement {
  const adapter = useMemo(() => createAdapter(mode), [mode]);
  const [startup, setStartup] = useState<Startup>({ state: 'starting' });
  const [tripId, setTripId] = useState<string | null>(adapter.demo?.tripId ?? null);

  useEffect(() => {
    let cancelled = false;
    void adapter.start().then(
      () => {
        if (!cancelled) setStartup({ state: 'ready' });
      },
      (error: unknown) => {
        // A live failure is reported as a failure. It never becomes demo data.
        if (!cancelled) {
          setStartup({
            state: 'error',
            message: error instanceof Error ? error.message : 'Could not start this mode',
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  return (
    <AdapterProvider adapter={adapter}>
      <div className="flex h-screen flex-col gap-3 overflow-hidden p-4 pb-12 md:p-6 md:pb-12">
        <Header adapter={adapter} onSwitch={onSwitch} />

        {startup.state === 'starting' && <p className="text-sm text-slate-500">Starting…</p>}

        {startup.state === 'error' && (
          <div className="grid gap-2 rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-800">{startup.message}</p>
            <button
              type="button"
              onClick={() => onSwitch('demo')}
              className="justify-self-start text-sm text-red-900 underline"
            >
              Open the demo instead
            </button>
          </div>
        )}

        {startup.state === 'ready' &&
          (tripId === null ? <Onboarding onTrip={setTripId} /> : <PlannerScreen tripId={tripId} />)}
      </div>
    </AdapterProvider>
  );
}

function Header({
  adapter,
  onSwitch,
}: {
  adapter: PlannerAdapter;
  onSwitch: (mode: Mode) => void;
}): React.ReactElement {
  const demo = adapter.mode === 'demo';
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold text-slate-900">Trip Planner</h1>
      <div className="flex items-center gap-3">
        {demo && (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
            Demo mode — simulated data
          </span>
        )}
        <button
          type="button"
          onClick={() => onSwitch(demo ? 'live' : 'demo')}
          className="text-sm text-slate-600 underline"
        >
          {demo ? 'Switch to live' : 'Switch to demo'}
        </button>
      </div>
    </header>
  );
}
