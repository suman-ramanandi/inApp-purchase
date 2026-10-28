import type { Kysely } from 'kysely';
import { Migrator, NO_MIGRATIONS, type MigrationResult } from 'kysely/migration';
import { migrations } from './migrations/index.ts';

export type MigrationTarget = 'latest' | 'down' | 'none';

/**
 * Runs migrations and throws if any fail. Kysely applies pending migrations in a single
 * transaction on PostgreSQL and holds an advisory lock, so concurrent runs are serialised and a
 * failure leaves the schema unchanged.
 */
export async function migrate<DB>(
  db: Kysely<DB>,
  target: MigrationTarget,
): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });

  const { error, results = [] } =
    target === 'latest'
      ? await migrator.migrateToLatest()
      : target === 'down'
        ? await migrator.migrateDown()
        : await migrator.migrateTo(NO_MIGRATIONS);

  if (error !== undefined) {
    const failed = results.find((r) => r.status === 'Error')?.migrationName;
    const message =
      failed === undefined ? 'Migrations could not run' : `Migration ${failed} failed`;
    throw new Error(message, { cause: error });
  }
  return results;
}
