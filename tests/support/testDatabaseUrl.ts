/**
 * Integration tests need a real Postgres, and they reset it destructively.
 *
 * The guard below is the reason this is a separate module: a test run must
 * never be pointed at the hosted demo project, whatever is in the shell.
 */
const FORBIDDEN_HOST_FRAGMENTS = ['supabase.co', 'supabase.com', 'pooler.supabase'];

export function requireTestDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'TEST_DATABASE_URL is not set.\n' +
        'Integration tests require a dedicated throwaway Postgres database.\n' +
        'See README.md, "Running the integration tests".',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid connection string');
  }

  const host = parsed.hostname.toLowerCase();
  if (FORBIDDEN_HOST_FRAGMENTS.some((fragment) => host.includes(fragment))) {
    throw new Error(
      'Refusing to run destructive integration tests against a hosted Supabase database. ' +
        'Point TEST_DATABASE_URL at a dedicated local or test-only database.',
    );
  }

  return url;
}
