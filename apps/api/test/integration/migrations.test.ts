import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { createTestDatabase, type TestDatabase } from './database.ts';

const DOMAIN_TABLES = [
  'app_users',
  'entitlement_grants',
  'entitlements',
  'product_entitlements',
  'products',
  'store_products',
  'store_transactions',
  'subscription_events',
  'subscriptions',
];

async function domainTables(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name not like 'kysely_%'
    order by table_name`.execute(db);
  return rows.map((r) => r.table_name);
}

describe('migrations', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.drop();
  });

  it('apply to an empty database', async () => {
    const results = await migrate(t.db, 'latest');
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ['0001_core_domain', 'Up', 'Success'],
    ]);
    expect(await domainTables(t.db)).toEqual(DOMAIN_TABLES);
  });

  it('are a no-op when already at the latest version', async () => {
    expect(await migrate(t.db, 'latest')).toEqual([]);
  });

  it('roll back completely', async () => {
    const results = await migrate(t.db, 'none');
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ['0001_core_domain', 'Down', 'Success'],
    ]);
    expect(await domainTables(t.db)).toEqual([]);
  });

  it('re-apply after a rollback', async () => {
    await migrate(t.db, 'latest');
    expect(await domainTables(t.db)).toEqual(DOMAIN_TABLES);
  });

  it('match the hand-written row types column for column', async () => {
    const { rows } = await sql<{ table_name: string; columns: string[] }>`
      select table_name, array_agg(column_name::text order by column_name) as columns
      from information_schema.columns
      where table_schema = 'public' and table_name not like 'kysely_%'
      group by table_name order by table_name`.execute(t.db);

    // Keep in sync with src/db/schema.ts. A failure here means a migration and the Kysely types
    // have drifted apart.
    const expected: Record<keyof Database, string[]> = {
      app_users: ['created_at', 'external_id', 'id'],
      entitlement_grants: [
        'created_at',
        'ends_at',
        'entitlement_id',
        'id',
        'revoked_at',
        'source',
        'starts_at',
        'subscription_id',
        'transaction_id',
        'updated_at',
        'user_id',
      ],
      entitlements: ['created_at', 'description', 'id', 'key'],
      product_entitlements: ['entitlement_id', 'product_id'],
      products: ['active', 'created_at', 'id', 'sku', 'type'],
      store_products: [
        'base_plan_id',
        'created_at',
        'id',
        'product_id',
        'store',
        'store_product_id',
      ],
      store_transactions: [
        'acknowledged_at',
        'consumed_at',
        'created_at',
        'currency',
        'environment',
        'expires_at',
        'id',
        'kind',
        'price_micros',
        'product_id',
        'purchased_at',
        'revocation_reason',
        'revoked_at',
        'store',
        'store_transaction_id',
        'subscription_id',
        'user_id',
        'verified_payload',
      ],
      subscription_events: [
        'cause',
        'from_status',
        'id',
        'observed_at',
        'recorded_at',
        'source',
        'subscription_id',
        'to_status',
      ],
      subscriptions: [
        'auto_renew',
        'created_at',
        'current_period_start',
        'environment',
        'expires_at',
        'grace_expires_at',
        'id',
        'last_observed_at',
        'product_id',
        'revocation_reason',
        'revoked_at',
        'status',
        'store',
        'store_subscription_key',
        'updated_at',
        'user_id',
      ],
    };
    expect(Object.fromEntries(rows.map((r) => [r.table_name, r.columns]))).toEqual(expected);
  });
});
