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
