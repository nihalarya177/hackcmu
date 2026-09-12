import { createClient } from '@supabase/supabase-js';

export interface AuthenticatedUser {
  /** Supabase auth user id. The only identity the server ever trusts. */
  id: string;
  isAnonymous: boolean;
}

/**
 * Verifies a bearer token. Returns null for any token that is absent, expired,
 * malformed or not recognised by the auth provider.
 */
export type AccessTokenVerifier = (accessToken: string) => Promise<AuthenticatedUser | null>;

/**
 * Asks Supabase Auth to verify the token. This deliberately makes a network
 * call rather than decoding the JWT locally: a decoded token proves nothing
 * about revocation or signature trust, and identity is the root of every
 * authorization decision here.
 *
 * It runs before any transaction is opened, never while a lock is held.
 */
export function createSupabaseVerifier(options: {
  supabaseUrl: string;
  publishableKey: string;
}): AccessTokenVerifier {
  const client = createClient(options.supabaseUrl, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return async (accessToken: string): Promise<AuthenticatedUser | null> => {
    const { data, error } = await client.auth.getUser(accessToken);
    if (error !== null || data.user === null) return null;
    return {
      id: data.user.id,
      isAnonymous: data.user.is_anonymous === true,
    };
  };
}
