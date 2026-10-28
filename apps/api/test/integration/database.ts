import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { inject } from 'vitest';
import { createDb } from '../../src/db/client.ts';
import type { Database } from '../../src/db/schema.ts';

export interface TestDatabase {
  db: Kysely<Database>;
  drop: () => Promise<void>;
}

/** Creates an empty database for one test file, so files can run in parallel without sharing data. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('adminDatabaseUrl');
  const name = `test_${randomUUID().replaceAll('-', '')}`;

  await withAdminClient(adminUrl, (client) => client.query(`create database ${name}`));

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());

  return {
    db,
    drop: async () => {
      await db.destroy();
      await withAdminClient(adminUrl, (client) =>
        client.query(`drop database ${name} with (force)`),
      );
    },
  };
}

async function withAdminClient(url: string, fn: (client: pg.Client) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

/** The PostgreSQL error raised by `promise`, for asserting on SQLSTATE and constraint names. */
export async function pgError(promise: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the database to reject the statement');
}
