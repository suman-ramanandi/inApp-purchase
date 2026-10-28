import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_core_domain.ts';

/**
 * Every migration, in order. Listed explicitly instead of read from the filesystem so the same
 * code works from source, from the build output and in tests. Never rename or edit an entry
 * after it has been applied anywhere; add a new one.
 */
export const migrations: Record<string, Migration> = {
  '0001_core_domain': m0001,
};
