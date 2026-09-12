import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tokens = { current: 'stale-token', refreshed: 'fresh-token' };

vi.mock('../../apps/web/src/lib/supabase', () => ({
  accessToken: () => Promise.resolve(tokens.current),
  currentAccessToken: () => Promise.resolve(tokens.refreshed),
  supabase: () => {
    throw new Error('not used in this test');
  },
  ensureAnonymousSession: () => Promise.resolve(''),
}));

vi.mock('../../apps/web/src/config/env', () => ({
  loadBrowserConfig: () => ({
    supabaseUrl: 'https://x',
    supabasePublishableKey: 'k',
    apiBaseUrl: '',
  }),
}));

const { api, ApiRequestError } = await import('../../apps/web/src/lib/api');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const unauthorized = {
  error: { code: 'UNAUTHENTICATED', message: 'A valid session is required', request_id: 'r' },
};

const snapshot = {
  trip: {
    id: '11111111-1111-4111-8111-111111111111',
    trip_name: 'Trip',
    group_name: 'Group',
    expected_headcount: 2,
    destination_label: 'Pittsburgh',
    destination_center: { lat: 40.4406, lon: -79.9959 },
    destination_bounds: null,
    timezone: 'America/New_York',
    currency: 'USD',
    creator_person_id: '22222222-2222-4222-8222-222222222222',
    start_date: '2026-10-02',
    end_date: '2026-10-02',
    dates: ['2026-10-02'],
    created_at: '2026-10-01T00:00:00.000Z',
  },
  self_person_id: '22222222-2222-4222-8222-222222222222',
  members: [],
  events: [],
  attendance: [],
  places: [],
  budgets: [],
  warnings: [],
  unknown_coverage: {
    unknown_price_event_ids: [],
    unresolved_place_event_ids: [],
    unknown_hours_event_ids: [],
  },
  day_paths: [],
  actions: [],
  recent_deletions: [],
  has_more_deletions: false,
  calendar_version: '1',
  processing: {
    state: 'idle',
    batch_id: null,
    attempts: 0,
    next_attempt_at: null,
    worker_available: false,
    provider_available: false,
    pending_user_message_count: 0,
    last_processed_message_id: '0',
    last_error_code: null,
    updated_at: '2026-10-01T00:00:00.000Z',
  },
  server_time: '2026-10-01T00:00:00.000Z',
};

let calls: { token: string | null }[] = [];

beforeEach(() => {
  calls = [];
  tokens.current = 'stale-token';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('expired access tokens', () => {
  it('refreshes and retries once when the server rejects a stale token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const token = new Headers(init.headers).get('authorization');
        calls.push({ token });
        // The token was valid when it was read and expired in flight.
        return Promise.resolve(
          token === 'Bearer stale-token'
            ? jsonResponse(401, unauthorized)
            : jsonResponse(200, snapshot),
        );
      }),
    );

    const result = await api.snapshot('11111111-1111-4111-8111-111111111111');
    expect(result.calendar_version).toBe('1');
    expect(calls.map((call) => call.token)).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
  });

  it('does not retry when the session has not moved on', async () => {
    // The same token coming back means this is a real authentication failure,
    // not a token that expired in flight.
    tokens.refreshed = 'stale-token';
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        calls.push({ token: new Headers(init.headers).get('authorization') });
        return Promise.resolve(jsonResponse(401, unauthorized));
      }),
    );

    await api.snapshot('11111111-1111-4111-8111-111111111111').catch(() => undefined);
    expect(calls).toHaveLength(1);
    tokens.refreshed = 'fresh-token';
  });

  it('gives up after one retry rather than looping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        calls.push({ token: new Headers(init.headers).get('authorization') });
        return Promise.resolve(jsonResponse(401, unauthorized));
      }),
    );

    const failure = await api
      .snapshot('11111111-1111-4111-8111-111111111111')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiRequestError);
    expect((failure as InstanceType<typeof ApiRequestError>).code).toBe('UNAUTHENTICATED');
    // Exactly two attempts: the original and one retry.
    expect(calls).toHaveLength(2);
  });

  it('does not retry a failure that is not an authentication problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        calls.push({ token: new Headers(init.headers).get('authorization') });
        return Promise.resolve(
          jsonResponse(409, {
            error: { code: 'STALE_VERSION', message: 'stale', request_id: 'r' },
          }),
        );
      }),
    );

    await api.snapshot('11111111-1111-4111-8111-111111111111').catch(() => undefined);
    expect(calls).toHaveLength(1);
  });
});
