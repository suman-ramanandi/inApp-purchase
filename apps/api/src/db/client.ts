import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

// int8 columns hold money in micros and identity ids. Parse them as exact bigints instead of pg's
// default strings. Scoped to this pool rather than set globally on the pg module.
const types = new pg.TypeOverrides();
types.setTypeParser(pg.types.builtins.INT8, (value: string) => BigInt(value));

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, types }) }),
  });
}
