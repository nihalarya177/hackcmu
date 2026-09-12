import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createAdapter, DEMO_TRIP_ID, type PlannerAdapter } from './adapter';
import type { SnapshotResponse } from '@trip/contracts';
import { browserStorage, resolveInitialMode, writeStoredMode, type Mode } from './mode';

/**
 * Mode gate.
 *
 * Nothing that needs credentials is touched until a mode is chosen, so the
 * prototype opens on a machine with no Supabase project, no keys and no API.
 * The planner itself is built on top of the adapter this hands down.
 */
export function App(): React.ReactElement {
  const storage = useMemo(() => browserStorage(), []);
  const [mode, setMode] = useState<Mode | null>(() =>
    resolveInitialMode({ search: window.location.search, storage: browserStorage() }),
  );
  const queryClient = useQueryClient();

  const choose = useCallback(
    (next: Mode | null) => {
      // Switching modes enters a separate namespace; nothing cached under the
      // previous one may survive into it.
      queryClient.clear();
      writeStoredMode(storage, next);
      setMode(next);
    },
    [queryClient, storage],
  );

  if (mode === null) return <ModeChooser onChoose={choose} />;
  return <ModeSession key={mode} mode={mode} onLeave={() => choose(null)} />;
}

function ModeChooser({ onChoose }: { onChoose: (mode: Mode) => void }): React.ReactElement {
  return (
    <Shell title="Trip Planner" subtitle="Choose how to open this build">
      <div className="grid gap-3">
        <button
          type="button"
          onClick={() => onChoose('demo')}
          className="rounded-lg border border-slate-300 bg-white p-4 text-left hover:border-slate-400"
        >
          <span className="block font-medium text-slate-900">Demo</span>
          <span className="block text-sm text-slate-600">
            A simulated four-person trip. No account, no credentials, nothing saved to a server.
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChoose('live')}
          className="rounded-lg border border-slate-300 bg-white p-4 text-left hover:border-slate-400"
        >
          <span className="block font-medium text-slate-900">Live</span>
          <span className="block text-sm text-slate-600">
            The real API and database. Requires configuration and a reachable server.
          </span>
        </button>
      </div>
    </Shell>
  );
}

type Startup = { state: 'starting' } | { state: 'ready' } | { state: 'error'; message: string };

function ModeSession({ mode, onLeave }: { mode: Mode; onLeave: () => void }): React.ReactElement {
  const adapter = useMemo(() => createAdapter(mode), [mode]);
  const [startup, setStartup] = useState<Startup>({ state: 'starting' });

  useEffect(() => {
    let cancelled = false;
    void adapter
      .start()
      .then(() => {
        if (!cancelled) setStartup({ state: 'ready' });
      })
      .catch((error: unknown) => {
        // A live failure is reported as a failure. It never becomes demo data.
        if (!cancelled) {
          setStartup({
            state: 'error',
            message: error instanceof Error ? error.message : 'Could not start this mode',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  return (
    <Shell
      title="Trip Planner"
      subtitle={mode === 'demo' ? 'Demo mode — simulated data' : 'Live mode'}
      onLeave={onLeave}
      demo={mode === 'demo'}
    >
      {startup.state === 'starting' && <p className="text-sm text-slate-600">Starting…</p>}
      {startup.state === 'error' && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {startup.message}
        </p>
      )}
      {startup.state === 'ready' && <AdapterSummary adapter={adapter} />}
    </Shell>
  );
}

/**
 * Temporary surface for the boundary itself: it shows what the chosen mode can
 * do and proves the adapter answers. The planner replaces it in the next step.
 */
function AdapterSummary({ adapter }: { adapter: PlannerAdapter }): React.ReactElement {
  const demo = adapter.demo;
  const [revision, bump] = useState(0);
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);

  useEffect(() => demo?.subscribe(() => bump((n) => n + 1)), [demo]);

  useEffect(() => {
    if (demo === null) return;
    let cancelled = false;
    void adapter.snapshot(demo.tripId).then(
      (result) => {
        if (!cancelled) setSnapshot(result);
      },
      () => {
        if (!cancelled) setSnapshot(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, demo, revision]);

  const available = Object.entries(adapter.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  return (
    <div className="grid gap-4">
      {demo !== null && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-medium text-slate-700">Acting as</h2>
          <div className="flex flex-wrap gap-2">
            {demo.participants().map((person) => (
              <button
                key={person.id}
                type="button"
                onClick={() => demo.switchParticipant(person.id)}
                className={`rounded-full border px-3 py-1 text-sm ${
                  person.id === demo.activePersonId()
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 bg-white text-slate-700'
                }`}
              >
                <span
                  aria-hidden
                  className="mr-2 inline-block size-2 rounded-full align-middle"
                  style={{ backgroundColor: person.color }}
                />
                {person.display_name}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => demo.reset()}
            className="mt-3 text-sm text-slate-600 underline"
          >
            Reset demo data
          </button>
          <p className="mt-2 text-xs text-slate-500">Trip {DEMO_TRIP_ID}</p>
        </section>
      )}

      {demo !== null && snapshot !== null && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-slate-700">
              {snapshot.trip.trip_name} · {snapshot.events.length} events · v
              {snapshot.calendar_version}
            </h2>
            <span className="text-xs text-slate-500">{snapshot.processing.state}</span>
          </div>

          <button
            type="button"
            onClick={() => {
              void adapter
                .requestProcessing(demo.tripId, { idempotency_key: `demo-${Date.now()}` })
                .then(() => setTimeout(() => bump((n) => n + 1), 1200));
            }}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white"
          >
            Update plan
          </button>

          <ul className="mt-3 grid gap-1">
            {demo.scenarios().map((scenario) => (
              <li key={scenario.id} className="text-sm">
                <button
                  type="button"
                  disabled={scenario.applied}
                  onClick={() => {
                    demo.runScenario(scenario.id);
                    setTimeout(() => bump((n) => n + 1), 1200);
                  }}
                  className="text-left text-slate-700 underline disabled:text-slate-400 disabled:no-underline"
                >
                  {scenario.title}
                </button>
                {scenario.applied && <span className="ml-2 text-xs text-slate-400">played</span>}
              </li>
            ))}
          </ul>

          {snapshot.warnings.length > 0 && (
            <ul className="mt-3 grid gap-1 border-t border-slate-200 pt-3">
              {snapshot.warnings.map((warning) => (
                <li key={warning.key} className="text-xs text-amber-800">
                  {warning.kind}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-medium text-slate-700">Available in this mode</h2>
        <p className="text-sm text-slate-600">{available.join(', ')}</p>
      </section>
    </div>
  );
}

function Shell({
  title,
  subtitle,
  children,
  onLeave,
  demo = false,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  onLeave?: () => void;
  demo?: boolean;
}): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
          <p className="text-sm text-slate-600">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3">
          {demo && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
              Demo mode
            </span>
          )}
          {onLeave !== undefined && (
            <button type="button" onClick={onLeave} className="text-sm text-slate-600 underline">
              Change mode
            </button>
          )}
        </div>
      </header>
      {children}
    </main>
  );
}
