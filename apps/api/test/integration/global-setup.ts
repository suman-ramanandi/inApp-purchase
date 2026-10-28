import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

/** Starts one disposable PostgreSQL for the integration run; test files create databases in it. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Same image as docker-compose.yml.
  const container = await new PostgreSqlContainer('postgres:16.15-alpine').start();
  project.provide('adminDatabaseUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
