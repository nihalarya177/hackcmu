import { useEffect, useState } from 'react';
import { ensureAnonymousSession } from './lib/supabase';
import { Planner } from './planner/Planner';
import { Start } from './planner/Start';

const TRIP_KEY = 'trip-planner.trip';

type Session = { state: 'starting' } | { state: 'ready' } | { state: 'error'; message: string };

/**
 * Identity is an anonymous Supabase session, established before anything is
 * read. The last trip is remembered per browser, so a refresh returns to the
 * conversation rather than to a form.
 */
export function App(): React.ReactElement {
  const [session, setSession] = useState<Session>({ state: 'starting' });
  const [tripId, setTripId] = useState<string | null>(() => remembered());

  useEffect(() => {
    let cancelled = false;
    void ensureAnonymousSession().then(
      () => {
        if (!cancelled) setSession({ state: 'ready' });
      },
      (error: unknown) => {
        if (!cancelled) {
          setSession({
            state: 'error',
            message: error instanceof Error ? error.message : 'Could not start a session',
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const open = (id: string): void => {
    try {
      localStorage.setItem(TRIP_KEY, id);
    } catch {
      // Not remembering the trip is a lost convenience, not a failure.
    }
    // The invite token has been used; keep it out of the address bar.
    window.history.replaceState(null, '', window.location.pathname);
    setTripId(id);
  };

  if (session.state === 'starting') {
    return <Notice>Starting…</Notice>;
  }
  if (session.state === 'error') {
    return (
      <Notice>
        <p className="text-red-800">{session.message}</p>
        <p className="mt-2 text-stone-500">
          The app needs its Supabase configuration and a reachable API.
        </p>
      </Notice>
    );
  }

  const forget = (): void => {
    try {
      localStorage.removeItem(TRIP_KEY);
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
    setTripId(null);
  };

  return tripId === null ? (
    <Start onTrip={open} />
  ) : (
    <Planner tripId={tripId} onUnreachable={forget} />
  );
}

function remembered(): string | null {
  try {
    return localStorage.getItem(TRIP_KEY);
  } catch {
    return null;
  }
}

function Notice({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <main className="grid min-h-screen place-items-center bg-stone-50 p-6">
      <div className="max-w-sm text-center text-sm text-stone-600">{children}</div>
    </main>
  );
}
