import { useEffect, useState } from 'react';
import { ensureAnonymousSession } from './lib/supabase';

type Status =
  | { state: 'checking' }
  | { state: 'ready'; sessionStarted: boolean }
  | { state: 'error'; message: string };

/**
 * Foundation shell.
 *
 * It proves the three things the milestone actually establishes: the browser
 * bundle reads only public configuration, an anonymous session can be
 * obtained, and the same-origin API answers. The planner itself is built on
 * top of this in the next milestone.
 */
export function App(): React.ReactElement {
  const [status, setStatus] = useState<Status>({ state: 'checking' });
  const [apiReady, setApiReady] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await ensureAnonymousSession();
        if (!cancelled) setStatus({ state: 'ready', sessionStarted: true });
      } catch (error) {
        if (!cancelled) {
          setStatus({
            state: 'error',
            message: error instanceof Error ? error.message : 'Could not start a session',
          });
        }
      }

      try {
        const response = await fetch('/health/ready');
        if (!cancelled) setApiReady(response.ok);
      } catch {
        if (!cancelled) setApiReady(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Trip Planner</h1>
        <p className="text-sm text-slate-600">Foundation build</p>
      </header>

      <dl className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        <Row label="Anonymous session">
          {status.state === 'checking' && <span className="text-slate-500">checking…</span>}
          {status.state === 'ready' && <span className="text-green-700">started</span>}
          {status.state === 'error' && <span className="text-red-700">{status.message}</span>}
        </Row>
        <Row label="API readiness">
          {apiReady === null && <span className="text-slate-500">checking…</span>}
          {apiReady === true && <span className="text-green-700">ready</span>}
          {apiReady === false && <span className="text-red-700">unavailable</span>}
        </Row>
      </dl>
    </main>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <dt className="font-medium text-slate-700">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
