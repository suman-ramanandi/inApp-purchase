import { sql, type Insertable } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SUBSCRIPTION_STATUSES,
  TRANSITION_CAUSES,
  type SubscriptionStatus,
} from '../../src/billing/lifecycle.ts';
import { findStoreProduct } from '../../src/catalogue/queries.ts';
import { migrate } from '../../src/db/migrator.ts';
import type { StoreTransactionsTable, SubscriptionsTable } from '../../src/db/schema.ts';
import { activeEntitlementKeys } from '../../src/entitlements/queries.ts';
import { createTestDatabase, pgError, type TestDatabase } from './database.ts';

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (days: number) => new Date(T0 + days * DAY);

let t: TestDatabase;
let db: TestDatabase['db'];

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  await migrate(db, 'latest');
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await db.deleteFrom('entitlement_grants').execute();
  await db.deleteFrom('subscription_events').execute();
  await db.deleteFrom('store_transactions').execute();
  await db.deleteFrom('subscriptions').execute();
  await db.deleteFrom('store_products').execute();
  await db.deleteFrom('product_entitlements').execute();
  await db.deleteFrom('products').execute();
  await db.deleteFrom('entitlements').execute();
  await db.deleteFrom('app_users').execute();
});

async function seedCatalogue() {
  const premium = await db
    .insertInto('entitlements')
    .values({ key: 'premium' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const product = await db
    .insertInto('products')
    .values({ sku: 'premium.monthly', type: 'subscription' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('product_entitlements')
    .values({ product_id: product.id, entitlement_id: premium.id })
    .execute();
  const user = await db
    .insertInto('app_users')
    .values({ external_id: 'user-1' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { premiumId: premium.id, productId: product.id, userId: user.id };
}

function subscriptionRow(
  ids: { userId: string; productId: string },
  status: SubscriptionStatus,
  overrides: Partial<Insertable<SubscriptionsTable>> = {},
): Insertable<SubscriptionsTable> {
  return {
    user_id: ids.userId,
    product_id: ids.productId,
    store: 'simulated',
    environment: 'sandbox',
    store_subscription_key: `sub-${status}`,
    status,
    auto_renew: true,
    current_period_start: at(0),
    expires_at: at(30),
    grace_expires_at: status === 'grace_period' ? at(36) : null,
    revoked_at: status === 'revoked' ? at(10) : null,
    revocation_reason: status === 'revoked' ? 'refund' : null,
    last_observed_at: at(1),
    ...overrides,
  };
}

describe('catalogue', () => {
  it('resolves a store product to its catalogue product and entitlements', async () => {
    const { productId } = await seedCatalogue();
    await db
      .insertInto('store_products')
      .values({
        product_id: productId,
        store: 'google',
        store_product_id: 'premium',
        base_plan_id: 'monthly',
      })
      .execute();

    expect(
      await findStoreProduct(db, {
        store: 'google',
        storeProductId: 'premium',
        basePlanId: 'monthly',
      }),
    ).toEqual({
      productId,
      sku: 'premium.monthly',
      type: 'subscription',
      entitlementKeys: ['premium'],
    });
    expect(
      await findStoreProduct(db, { store: 'google', storeProductId: 'premium', basePlanId: null }),
    ).toBeNull();
  });

  it('does not resolve inactive products', async () => {
    const { productId } = await seedCatalogue();
    await db
      .insertInto('store_products')
      .values({ product_id: productId, store: 'apple', store_product_id: 'com.example.premium' })
      .execute();
    await db.updateTable('products').set({ active: false }).execute();

    expect(
      await findStoreProduct(db, {
        store: 'apple',
        storeProductId: 'com.example.premium',
        basePlanId: null,
      }),
    ).toBeNull();
  });

  it('treats a missing base plan as a value in the uniqueness check', async () => {
    const { productId } = await seedCatalogue();
    const row = {
      product_id: productId,
      store: 'apple' as const,
      store_product_id: 'com.example.premium',
    };
    await db.insertInto('store_products').values(row).execute();

    const error = await pgError(db.insertInto('store_products').values(row).execute());
    expect([error.code, error.constraint]).toEqual(['23505', 'store_products_identity_key']);
  });

  it('allows a base plan only for Google Play', async () => {
    const { productId } = await seedCatalogue();
    const error = await pgError(
      db
        .insertInto('store_products')
        .values({
          product_id: productId,
          store: 'apple',
          store_product_id: 'x',
          base_plan_id: 'monthly',
        })
        .execute(),
    );
    expect([error.code, error.constraint]).toEqual([
      '23514',
      'store_products_base_plan_google_only',
    ]);
  });

  it('rejects malformed entitlement keys and SKUs', async () => {
    const key = await pgError(
      db.insertInto('entitlements').values({ key: 'Premium Plan' }).execute(),
    );
    expect(key.constraint).toBe('entitlements_key_format');

    const sku = await pgError(
      db.insertInto('products').values({ sku: ' bad sku', type: 'subscription' }).execute(),
    );
    expect(sku.constraint).toBe('products_sku_format');
  });
});

describe('subscriptions', () => {
  it.each(SUBSCRIPTION_STATUSES)('stores a consistent %s subscription', async (status) => {
    const ids = await seedCatalogue();
    await db.insertInto('subscriptions').values(subscriptionRow(ids, status)).execute();
  });

  it('allows one row per store subscription (the idempotency key)', async () => {
    const ids = await seedCatalogue();
    await db.insertInto('subscriptions').values(subscriptionRow(ids, 'active')).execute();

    const error = await pgError(
      db.insertInto('subscriptions').values(subscriptionRow(ids, 'active')).execute(),
    );
    expect([error.code, error.constraint]).toEqual(['23505', 'subscriptions_store_identity_key']);

    // The same key in the other environment is a different subscription.
    await db
      .insertInto('subscriptions')
      .values(subscriptionRow(ids, 'active', { environment: 'production' }))
      .execute();
  });

  const invalid: [string, SubscriptionStatus, Partial<Insertable<SubscriptionsTable>>, string][] = [
    [
      'period ending before it starts',
      'active',
      { expires_at: at(0) },
      'subscriptions_period_order',
    ],
    [
      'grace period without an end',
      'grace_period',
      { grace_expires_at: null },
      'subscriptions_grace_matches_status',
    ],
    [
      'grace end on an active subscription',
      'active',
      { grace_expires_at: at(36) },
      'subscriptions_grace_matches_status',
    ],
    [
      'grace ending before the period',
      'grace_period',
      { grace_expires_at: at(30) },
      'subscriptions_grace_after_expiry',
    ],
    [
      'revoked without a time',
      'revoked',
      { revoked_at: null, revocation_reason: null },
      'subscriptions_revocation_matches_status',
    ],
    [
      'revocation time without a reason',
      'revoked',
      { revocation_reason: null },
      'subscriptions_revocation_complete',
    ],
    [
      'unknown status',
      'active',
      { status: 'cancelled' as SubscriptionStatus },
      'subscriptions_status_check',
    ],
  ];

  it.each(invalid)('rejects %s', async (_name, status, overrides, constraint) => {
    const ids = await seedCatalogue();
    const error = await pgError(
      db
        .insertInto('subscriptions')
        .values(subscriptionRow(ids, status, overrides))
        .execute(),
    );
    expect([error.code, error.constraint]).toEqual(['23514', constraint]);
  });

  it('records every lifecycle cause and rejects unknown ones', async () => {
    const ids = await seedCatalogue();
    const sub = await db
      .insertInto('subscriptions')
      .values(subscriptionRow(ids, 'active'))
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('subscription_events')
      .values(
        TRANSITION_CAUSES.map((cause) => ({
          subscription_id: sub.id,
          cause,
          from_status: cause === 'created' ? null : ('active' as const),
          to_status: 'active' as const,
          source: 'verification' as const,
          observed_at: at(1),
        })),
      )
      .execute();

    const error = await pgError(
      db
        .insertInto('subscription_events')
        .values({
          subscription_id: sub.id,
          cause: 'teleported' as 'created',
          from_status: 'active',
          to_status: 'active',
          source: 'webhook',
          observed_at: at(1),
        })
        .execute(),
    );
    expect(error.constraint).toBe('subscription_events_cause_check');
  });
});

describe('store transactions', () => {
  async function transaction(overrides: Partial<Insertable<StoreTransactionsTable>> = {}) {
    const ids = await seedCatalogue();
    return {
      ids,
      row: {
        user_id: ids.userId,
        product_id: ids.productId,
        store: 'simulated' as const,
        environment: 'sandbox' as const,
        store_transaction_id: 'txn-1',
        kind: 'purchase' as const,
        purchased_at: at(0),
        price_micros: 9_990_000n,
        currency: 'USD',
        verified_payload: JSON.stringify({ transactionId: 'txn-1' }),
        ...overrides,
      },
    };
  }

  it('stores each store transaction once; a replay inserts nothing', async () => {
    const { row } = await transaction();
    await db.insertInto('store_transactions').values(row).execute();

    const replay = await db
      .insertInto('store_transactions')
      .values(row)
      .onConflict((oc) => oc.constraint('store_transactions_store_identity_key').doNothing())
      .returning('id')
      .execute();
    expect(replay).toEqual([]);
    expect(await db.selectFrom('store_transactions').select('id').execute()).toHaveLength(1);
  });

  it('round-trips money beyond Number.MAX_SAFE_INTEGER exactly', async () => {
    const price = 9_007_199_254_740_993n;
    const { row } = await transaction({ price_micros: price });
    await db.insertInto('store_transactions').values(row).execute();

    const stored = await db
      .selectFrom('store_transactions')
      .select('price_micros')
      .executeTakeFirstOrThrow();
    expect(stored.price_micros).toBe(price);
  });

  const invalid: [string, Partial<Insertable<StoreTransactionsTable>>, string][] = [
    ['a negative price', { price_micros: -1n }, 'store_transactions_price_non_negative'],
    ['a lowercase currency', { currency: 'usd' }, 'store_transactions_currency_format'],
    ['a price without a currency', { currency: null }, 'store_transactions_price_has_currency'],
    [
      'a renewal without a subscription',
      { kind: 'renewal' },
      'store_transactions_renewal_has_subscription',
    ],
    ['an expiry before the purchase', { expires_at: at(-1) }, 'store_transactions_expiry_order'],
  ];

  it.each(invalid)('rejects %s', async (_name, overrides, constraint) => {
    const { row } = await transaction(overrides);
    const error = await pgError(db.insertInto('store_transactions').values(row).execute());
    expect([error.code, error.constraint]).toEqual(['23514', constraint]);
  });
});

describe('entitlement grants', () => {
  async function grant(
    ids: { userId: string; premiumId: string },
    window: { starts_at: Date; ends_at: Date | null; revoked_at?: Date | null },
  ) {
    await db
      .insertInto('entitlement_grants')
      .values({ user_id: ids.userId, entitlement_id: ids.premiumId, source: 'manual', ...window })
      .execute();
  }

  it('returns only grants that are in effect at the given time', async () => {
    const ids = await seedCatalogue();
    await grant(ids, { starts_at: at(0), ends_at: at(30) });

    expect(await activeEntitlementKeys(db, ids.userId, at(-1))).toEqual([]);
    expect(await activeEntitlementKeys(db, ids.userId, at(0))).toEqual(['premium']);
    expect(await activeEntitlementKeys(db, ids.userId, new Date(at(30).getTime() - 1))).toEqual([
      'premium',
    ]);
    expect(await activeEntitlementKeys(db, ids.userId, at(30))).toEqual([]);
  });

  it('ignores revoked grants and treats a missing end as open-ended', async () => {
    const ids = await seedCatalogue();
    await grant(ids, { starts_at: at(0), ends_at: null, revoked_at: at(5) });
    expect(await activeEntitlementKeys(db, ids.userId, at(10))).toEqual([]);

    await grant(ids, { starts_at: at(0), ends_at: null });
    expect(await activeEntitlementKeys(db, ids.userId, at(1000))).toEqual(['premium']);
  });

  it('requires the reference that matches the grant source', async () => {
    const ids = await seedCatalogue();
    const error = await pgError(
      db
        .insertInto('entitlement_grants')
        .values({
          user_id: ids.userId,
          entitlement_id: ids.premiumId,
          source: 'subscription',
          starts_at: at(0),
          ends_at: null,
        })
        .execute(),
    );
    expect(error.constraint).toBe('entitlement_grants_source_reference');
  });

  it('keeps one grant per subscription and entitlement', async () => {
    const ids = await seedCatalogue();
    const sub = await db
      .insertInto('subscriptions')
      .values(subscriptionRow(ids, 'active'))
      .returning('id')
      .executeTakeFirstOrThrow();
    const row = {
      user_id: ids.userId,
      entitlement_id: ids.premiumId,
      source: 'subscription' as const,
      subscription_id: sub.id,
      starts_at: at(0),
      ends_at: at(30),
    };
    await db.insertInto('entitlement_grants').values(row).execute();

    const error = await pgError(db.insertInto('entitlement_grants').values(row).execute());
    expect([error.code, error.constraint]).toEqual([
      '23505',
      'entitlement_grants_subscription_key',
    ]);
  });
});

// Regression: user_id on transactions and grants was not tied to the owning subscription or
// transaction, so rows for one user could hang off another user's subscription.
describe('ownership', () => {
  async function twoUsersAndSubscription() {
    const ids = await seedCatalogue();
    const other = await db
      .insertInto('app_users')
      .values({ external_id: 'user-2' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const sub = await db
      .insertInto('subscriptions')
      .values(subscriptionRow(ids, 'active'))
      .returning('id')
      .executeTakeFirstOrThrow();
    return { ...ids, otherUserId: other.id, subscriptionId: sub.id };
  }

  function renewal(userId: string, productId: string, subscriptionId: string) {
    return {
      user_id: userId,
      product_id: productId,
      subscription_id: subscriptionId,
      store: 'simulated' as const,
      environment: 'sandbox' as const,
      store_transaction_id: 'txn-renewal',
      kind: 'renewal' as const,
      purchased_at: at(30),
      verified_payload: '{}',
    };
  }

  it("rejects a transaction attached to another user's subscription", async () => {
    const ids = await twoUsersAndSubscription();
    const error = await pgError(
      db
        .insertInto('store_transactions')
        .values(renewal(ids.otherUserId, ids.productId, ids.subscriptionId))
        .execute(),
    );
    expect([error.code, error.constraint]).toEqual([
      '23503',
      'store_transactions_subscription_owner_fkey',
    ]);

    await db
      .insertInto('store_transactions')
      .values(renewal(ids.userId, ids.productId, ids.subscriptionId))
      .execute();
  });

  it("rejects a grant derived from another user's subscription", async () => {
    const ids = await twoUsersAndSubscription();
    const error = await pgError(
      db
        .insertInto('entitlement_grants')
        .values({
          user_id: ids.otherUserId,
          entitlement_id: ids.premiumId,
          source: 'subscription',
          subscription_id: ids.subscriptionId,
          starts_at: at(0),
          ends_at: at(30),
        })
        .execute(),
    );
    expect([error.code, error.constraint]).toEqual([
      '23503',
      'entitlement_grants_subscription_owner_fkey',
    ]);
  });

  it("rejects a grant derived from another user's transaction", async () => {
    const ids = await twoUsersAndSubscription();
    const txn = await db
      .insertInto('store_transactions')
      .values(renewal(ids.userId, ids.productId, ids.subscriptionId))
      .returning('id')
      .executeTakeFirstOrThrow();
    const error = await pgError(
      db
        .insertInto('entitlement_grants')
        .values({
          user_id: ids.otherUserId,
          entitlement_id: ids.premiumId,
          source: 'transaction',
          transaction_id: txn.id,
          starts_at: at(0),
          ends_at: null,
        })
        .execute(),
    );
    expect([error.code, error.constraint]).toEqual([
      '23503',
      'entitlement_grants_transaction_owner_fkey',
    ]);
  });
});

describe('timestamps', () => {
  it('round-trip to the millisecond regardless of the client time zone', async () => {
    // The integration project runs with a non-UTC TZ (see vitest.config.ts), so this exercises
    // pg's offset handling. Staleness checks compare lastObservedAt exactly, so precision matters.
    expect(new Date(0).getTimezoneOffset()).not.toBe(0);
    const ids = await seedCatalogue();
    const observed = new Date('2026-03-05T13:47:21.123Z');
    await db
      .insertInto('subscriptions')
      .values(subscriptionRow(ids, 'active', { last_observed_at: observed }))
      .execute();

    const row = await db
      .selectFrom('subscriptions')
      .select([
        'last_observed_at',
        sql<string>`(last_observed_at at time zone 'UTC')::text`.as('utc'),
      ])
      .executeTakeFirstOrThrow();
    expect(row.last_observed_at.getTime()).toBe(observed.getTime());
    expect(row.utc).toBe('2026-03-05 13:47:21.123');
  });
});
