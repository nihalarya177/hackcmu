import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

/**
 * Tests run against workspace source rather than build output, so a stale dist
 * can never make a failing change look green.
 */
const alias = {
  '@trip/contracts': path.resolve(root, 'packages/contracts/src/index.ts'),
  '@trip/db': path.resolve(root, 'packages/db/src/index.ts'),
  '@trip/server': path.resolve(root, 'apps/server/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/support/globalSetup.ts'],
          // Each file gets the same database; run them one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
