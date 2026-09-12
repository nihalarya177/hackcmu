import { defineConfig, devices } from '@playwright/test';

/**
 * Desktop-first two-browser collaboration tests.
 *
 * These need a real Supabase project for anonymous sign-in, so they are not
 * part of the default verification run. `npm run test:e2e` starts the built
 * web app and the API against whatever the local environment provides.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: process.env['CI'] === 'true',
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev:api',
      url: 'http://127.0.0.1:3000/health/live',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run preview -w @trip/web -- --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
