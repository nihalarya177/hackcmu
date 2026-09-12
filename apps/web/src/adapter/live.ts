import { UnsupportedOperationError } from '../lib/apiError';
import { api } from '../lib/api';
import { ensureAnonymousSession } from '../lib/supabase';
import type { Capabilities, PlannerAdapter } from './types';

/**
 * Exactly what the server implements today (M0: identity, trips, invites,
 * chat, snapshot, processing status, self and trip patches). Everything else
 * is M1-M4 and stays false until its endpoint exists, so the UI cannot render
 * a working-looking control backed by a missing route.
 */
const LIVE_CAPABILITIES: Capabilities = {
  chat: true,
  invite: true,
  selfProfile: true,
  tripSettings: true,
  manualEvents: false,
  eventRestore: false,
  selfAttendance: false,
  places: false,
  botActions: false,
  requestProcessing: false,
  export: false,
  participantSwitching: false,
  reset: false,
};

/** A rejected promise, never an inline throw: the caller only has `.catch`. */
function unsupported(operation: string): Promise<never> {
  return Promise.reject(new UnsupportedOperationError('live', operation));
}

/**
 * Live mode. Every method is a direct call to the real API; failures surface as
 * `ApiRequestError` and are never replaced with demo data.
 */
export function createLiveAdapter(): PlannerAdapter {
  return {
    mode: 'live',
    capabilities: LIVE_CAPABILITIES,
    demo: null,

    async start() {
      await ensureAnonymousSession();
    },

    createTrip: (body) => api.createTrip(body),
    previewInvite: (token) => api.previewInvite(token),
    joinTrip: (body) => api.joinTrip(body),
    mintInvite: (tripId, body) => api.mintInvite(tripId, body),

    snapshot: (tripId) => api.snapshot(tripId),
    processing: (tripId) => api.processing(tripId),
    messages: (tripId, params) => api.messages(tripId, params),
    sendMessage: (tripId, body) => api.sendMessage(tripId, body),

    patchSelf: (tripId, body) => api.patchSelf(tripId, body),
    patchTrip: (tripId, body) => api.patchTrip(tripId, body),

    createEvent: () => unsupported('createEvent'),
    patchEvent: () => unsupported('patchEvent'),
    deleteEvent: () => unsupported('deleteEvent'),
    restoreEvent: () => unsupported('restoreEvent'),
    setSelfAttendance: () => unsupported('setSelfAttendance'),
    requestProcessing: () => unsupported('requestProcessing'),
    resolveAction: () => unsupported('resolveAction'),
  };
}
