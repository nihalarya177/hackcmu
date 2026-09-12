import { z } from 'zod';

/**
 * Browser configuration.
 *
 * Only values that are safe to ship in a bundle may carry the VITE_ prefix.
 * No database URL, service key or provider secret belongs here, and nothing
 * outside this schema is read from import.meta.env.
 */
const browserEnv = z.object({
  VITE_SUPABASE_URL: z.url(),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  VITE_API_BASE_URL: z.string().default(''),
});

export type BrowserConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  apiBaseUrl: string;
};

export function loadBrowserConfig(): BrowserConfig {
  const parsed = browserEnv.safeParse(import.meta.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Missing or invalid browser configuration: ${names}`);
  }
  return {
    supabaseUrl: parsed.data.VITE_SUPABASE_URL,
    supabasePublishableKey: parsed.data.VITE_SUPABASE_PUBLISHABLE_KEY,
    apiBaseUrl: parsed.data.VITE_API_BASE_URL,
  };
}
