import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['apps/*/src/**/*.test.ts'],
          environment: 'node',
          restoreMocks: true,
        },
      },
      {
        // Needs Docker: global setup starts PostgreSQL with Testcontainers.
        test: {
          name: 'integration',
          include: ['apps/*/test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['apps/api/test/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
