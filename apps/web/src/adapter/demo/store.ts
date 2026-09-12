import { DEMO_SCHEMA, seedDemoState } from './dataset';
import type { DemoState } from './state';

const STORAGE_KEY = 'trip-planner.demo.v1';

/**
 * Simulated state, persisted per browser.
 *
 * Only non-sensitive simulated data is written, under its own key, and a
 * schema mismatch or unreadable value re-seeds rather than throwing. Nothing
 * here is shared between devices, and nothing here reaches a real trip.
 */
export class DemoStore {
  #state: DemoState;
  readonly #storage: Storage | null;
  readonly #listeners = new Set<() => void>();

  constructor(storage: Storage | null) {
    this.#storage = storage;
    this.#state = this.#load();
  }

  get state(): DemoState {
    return this.#state;
  }

  /** Replaces state and persists. The only write path. */
  update(next: DemoState): void {
    this.#state = next;
    this.#persist();
    for (const listener of this.#listeners) listener();
  }

  /** Restores the seeded dataset. Demo storage only; no backend is contacted. */
  reset(): void {
    this.update(seedDemoState());
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #load(): DemoState {
    if (this.#storage === null) return seedDemoState();
    let raw: string | null;
    try {
      raw = this.#storage.getItem(STORAGE_KEY);
    } catch {
      return seedDemoState();
    }
    if (raw === null) return seedDemoState();

    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { schema?: unknown }).schema === DEMO_SCHEMA
      ) {
        return parsed as DemoState;
      }
    } catch {
      // Corrupt or older demo state is discarded, never migrated silently.
    }
    return seedDemoState();
  }

  #persist(): void {
    if (this.#storage === null) return;
    try {
      this.#storage.setItem(STORAGE_KEY, JSON.stringify(this.#state));
    } catch {
      // A full or blocked quota must not break the running demo; the session
      // simply stops surviving a reload.
    }
  }
}
