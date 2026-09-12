import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadBrowserConfig } from '../config/env';

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (client === null) {
    const config = loadBrowserConfig();
    client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}

/**
 * Identity is the SDK-managed anonymous session, not a cached person id.
 * Clearing browser storage or moving to another device is a new identity, and
 * no display name can recover someone else's membership.
 */
export async function ensureAnonymousSession(): Promise<string> {
  const auth = supabase().auth;
  const existing = await auth.getSession();
  if (existing.data.session !== null) return existing.data.session.access_token;

  const created = await auth.signInAnonymously();
  if (created.error !== null || created.data.session === null) {
    throw new Error(created.error?.message ?? 'Could not start an anonymous session');
  }
  return created.data.session.access_token;
}

export async function accessToken(): Promise<string | null> {
  const { data } = await supabase().auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Re-reads the session, letting the SDK refresh it if it needs to.
 *
 * Deliberately not `refreshSession()`. Refresh tokens rotate, so an explicit
 * refresh can present one the background auto-refresh has already consumed;
 * that fails, and the SDK then deletes the session. For an anonymous identity
 * that is unrecoverable — a new identity is not a member of anything, and the
 * trip becomes permanently unreachable. `getSession` refreshes only when it
 * must and serialises concurrent callers.
 */
export async function currentAccessToken(): Promise<string | null> {
  const { data } = await supabase().auth.getSession();
  return data.session?.access_token ?? null;
}
