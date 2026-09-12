/**
 * Demo / Live mode selection.
 *
 * This module is deliberately dependency-free: it reads no configuration,
 * creates no Supabase client and imports nothing from `lib/`. The mode has to
 * be known *before* any backend dependency is initialised, because Demo mode
 * must start on a machine with no credentials at all.
 */

export type Mode = 'demo' | 'live';

const STORAGE_KEY = 'trip-planner.mode';

export function isMode(value: unknown): value is Mode {
  return value === 'demo' || value === 'live';
}

/** `?mode=demo` wins over anything remembered, so a link can force a mode. */
export function modeFromSearch(search: string): Mode | null {
  const value = new URLSearchParams(search).get('mode');
  return isMode(value) ? value : null;
}

export function readStoredMode(storage: Storage | null): Mode | null {
  if (storage === null) return null;
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isMode(value) ? value : null;
  } catch {
    // Storage can throw in private windows. An unreadable preference is simply
    // no preference; it must never stop the app from starting.
    return null;
  }
}

export function writeStoredMode(storage: Storage | null, mode: Mode | null): void {
  if (storage === null) return;
  try {
    if (mode === null) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, mode);
  } catch {
    // Not being able to remember the choice is not a failure of the choice.
  }
}

/**
 * `null` means "ask": no mode has been chosen yet. Returning null rather than
 * defaulting to live is the point — defaulting to live would initialise Auth
 * for someone who only wants the prototype.
 */
export function resolveInitialMode(options: {
  search?: string;
  storage?: Storage | null;
}): Mode | null {
  const search = options.search ?? '';
  const storage = options.storage ?? null;
  return modeFromSearch(search) ?? readStoredMode(storage);
}

export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
