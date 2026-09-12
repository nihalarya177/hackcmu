import type { Mode } from '../mode';
import { browserStorage } from '../mode';
import { createDemoAdapter } from './demo/adapter';
import { DEMO_TRIP_ID } from './demo/dataset';
import { createLiveAdapter } from './live';
import type { PlannerAdapter } from './types';

export { DEMO_TRIP_ID };
export type { Capabilities, Capability, DemoControls, PlannerAdapter } from './types';
export { ApiRequestError, UnsupportedOperationError } from '../lib/apiError';

/**
 * Builds the adapter for a chosen mode.
 *
 * Constructing a demo adapter reads no configuration and contacts nothing;
 * constructing a live one does not authenticate either, because that belongs to
 * `start()`. Switching modes means discarding this adapter and any cached query
 * state built from it — the two namespaces never mix.
 */
export function createAdapter(mode: Mode): PlannerAdapter {
  return mode === 'demo' ? createDemoAdapter(browserStorage()) : createLiveAdapter();
}
