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
          // A non-UTC zone with an odd offset and daylight saving, so timestamp handling is tested
          // against something other than the UTC that CI runners use.
          env: { TZ: 'Pacific/Chatham' },
          globalSetup: ['apps/api/test/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
