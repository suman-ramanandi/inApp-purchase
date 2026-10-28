import { sql, type Kysely, type RawBuilder } from 'kysely';

/**
 * Catalogue, users, subscriptions, transactions, subscription history and entitlement grants.
 *
 * Conventions (see docs/adr/002-subscription-lifecycle-and-schema.md):
 * - Closed value sets are `text` with named CHECK constraints, not enum types, so values can be
 *   added in an ordinary migration. Literals are written out here rather than imported from
 *   application code, so this migration never changes after it has run.
 * - Every constraint is named, so errors and tests can refer to it.
 * - Timestamps are `timestamptz`; money is `bigint` micros plus an ISO 4217 code.
 */

const STORES = sql`('apple', 'google', 'simulated')`;
const ENVIRONMENTS = sql`('production', 'sandbox')`;
const STATUSES = sql`('active', 'grace_period', 'billing_retry', 'paused', 'expired', 'revoked')`;
const REVOCATION_REASONS = sql`('refund', 'revoked')`;

const upStatements: RawBuilder<unknown>[] = [
  sql`
    create table app_users (
      id uuid primary key default gen_random_uuid(),
      external_id text not null,
      created_at timestamptz not null default now(),
      constraint app_users_external_id_key unique (external_id),
      constraint app_users_external_id_length check (length(external_id) between 1 and 255)
    )`,

  sql`
    create table entitlements (
      id uuid primary key default gen_random_uuid(),
      key text not null,
      description text not null default '',
      created_at timestamptz not null default now(),
      constraint entitlements_key_key unique (key),
      constraint entitlements_key_format check (key ~ '^[a-z][a-z0-9_]{0,62}$')
    )`,

  sql`
    create table products (
      id uuid primary key default gen_random_uuid(),
      sku text not null,
      type text not null,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      constraint products_sku_key unique (sku),
      constraint products_sku_format check (sku ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
      constraint products_type_check
        check (type in ('consumable', 'non_consumable', 'subscription'))
    )`,

  sql`
    create table product_entitlements (
      product_id uuid not null references products (id) on delete cascade,
      entitlement_id uuid not null references entitlements (id) on delete restrict,
      constraint product_entitlements_pkey primary key (product_id, entitlement_id)
    )`,
  sql`create index product_entitlements_entitlement_idx on product_entitlements (entitlement_id)`,

  sql`
    create table store_products (
      id uuid primary key default gen_random_uuid(),
      product_id uuid not null references products (id) on delete restrict,
      store text not null,
      store_product_id text not null,
      base_plan_id text,
      created_at timestamptz not null default now(),
      constraint store_products_store_check check (store in ${STORES}),
      constraint store_products_store_product_id_length check (length(store_product_id) > 0),
      constraint store_products_base_plan_google_only
        check (base_plan_id is null or store = 'google'),
      constraint store_products_identity_key
        unique nulls not distinct (store, store_product_id, base_plan_id)
    )`,
  sql`create index store_products_product_idx on store_products (product_id)`,

  sql`
    create table subscriptions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references app_users (id) on delete restrict,
      product_id uuid not null references products (id) on delete restrict,
      store text not null,
      environment text not null,
      store_subscription_key text not null,
      status text not null,
      auto_renew boolean not null,
      current_period_start timestamptz not null,
      expires_at timestamptz not null,
      grace_expires_at timestamptz,
      revoked_at timestamptz,
      revocation_reason text,
      last_observed_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint subscriptions_store_check check (store in ${STORES}),
      constraint subscriptions_environment_check check (environment in ${ENVIRONMENTS}),
      constraint subscriptions_status_check check (status in ${STATUSES}),
      constraint subscriptions_revocation_reason_check
        check (revocation_reason in ${REVOCATION_REASONS}),
      constraint subscriptions_store_key_length check (length(store_subscription_key) > 0),
      constraint subscriptions_store_identity_key
        unique (store, environment, store_subscription_key),
      constraint subscriptions_id_user_key unique (id, user_id),
      constraint subscriptions_period_order check (expires_at > current_period_start),
      constraint subscriptions_grace_matches_status
        check ((status = 'grace_period') = (grace_expires_at is not null)),
      constraint subscriptions_grace_after_expiry
        check (grace_expires_at is null or grace_expires_at > expires_at),
      constraint subscriptions_revocation_matches_status
        check ((status = 'revoked') = (revoked_at is not null)),
      constraint subscriptions_revocation_complete
        check ((revoked_at is null) = (revocation_reason is null))
    )`,
  sql`create index subscriptions_user_idx on subscriptions (user_id)`,

  sql`
    create table store_transactions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references app_users (id) on delete restrict,
      product_id uuid not null references products (id) on delete restrict,
      subscription_id uuid,
      store text not null,
      environment text not null,
      store_transaction_id text not null,
      kind text not null,
      purchased_at timestamptz not null,
      expires_at timestamptz,
      revoked_at timestamptz,
      revocation_reason text,
      price_micros bigint,
      currency text,
      acknowledged_at timestamptz,
      consumed_at timestamptz,
      verified_payload jsonb not null,
      created_at timestamptz not null default now(),
      constraint store_transactions_store_check check (store in ${STORES}),
      constraint store_transactions_environment_check check (environment in ${ENVIRONMENTS}),
      constraint store_transactions_kind_check check (kind in ('purchase', 'renewal')),
      constraint store_transactions_revocation_reason_check
        check (revocation_reason in ${REVOCATION_REASONS}),
      constraint store_transactions_store_identity_key
        unique (store, environment, store_transaction_id),
      constraint store_transactions_id_user_key unique (id, user_id),
      constraint store_transactions_subscription_owner_fkey foreign key (subscription_id, user_id)
        references subscriptions (id, user_id) on delete restrict,
      constraint store_transactions_renewal_has_subscription
        check (kind <> 'renewal' or subscription_id is not null),
      constraint store_transactions_expiry_order
        check (expires_at is null or expires_at > purchased_at),
      constraint store_transactions_revocation_complete
        check ((revoked_at is null) = (revocation_reason is null)),
      constraint store_transactions_price_non_negative check (price_micros >= 0),
      constraint store_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
      constraint store_transactions_price_has_currency
        check ((price_micros is null) = (currency is null))
    )`,
  sql`create index store_transactions_user_idx on store_transactions (user_id)`,
  sql`create index store_transactions_subscription_idx on store_transactions (subscription_id)`,

  sql`
    create table subscription_events (
      id bigint generated always as identity primary key,
      subscription_id uuid not null references subscriptions (id) on delete restrict,
      cause text not null,
      from_status text,
      to_status text not null,
      source text not null,
      observed_at timestamptz not null,
      recorded_at timestamptz not null default now(),
      constraint subscription_events_cause_check check (cause in (
        'created', 'renewed', 'billing_failed', 'grace_period_expired', 'recovered', 'paused',
        'resumed', 'expired', 'resubscribed', 'refunded', 'revoked', 'refund_reversed',
        'auto_renew_disabled', 'auto_renew_enabled', 'details_changed'
      )),
      constraint subscription_events_from_status_check check (from_status in ${STATUSES}),
      constraint subscription_events_to_status_check check (to_status in ${STATUSES}),
      constraint subscription_events_source_check
        check (source in ('verification', 'webhook', 'reconciliation', 'admin')),
      constraint subscription_events_created_has_no_from
        check ((cause = 'created') = (from_status is null))
    )`,
  sql`
    create index subscription_events_subscription_idx
      on subscription_events (subscription_id, id)`,

  sql`
    create table entitlement_grants (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references app_users (id) on delete restrict,
      entitlement_id uuid not null references entitlements (id) on delete restrict,
      source text not null,
      subscription_id uuid,
      transaction_id uuid,
      starts_at timestamptz not null,
      ends_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint entitlement_grants_source_check
        check (source in ('subscription', 'transaction', 'manual')),
      constraint entitlement_grants_source_reference check (
        (source = 'subscription' and subscription_id is not null and transaction_id is null) or
        (source = 'transaction' and transaction_id is not null and subscription_id is null) or
        (source = 'manual' and subscription_id is null and transaction_id is null)
      ),
      constraint entitlement_grants_window_order check (ends_at is null or ends_at > starts_at),
      constraint entitlement_grants_subscription_key unique (subscription_id, entitlement_id),
      constraint entitlement_grants_transaction_key unique (transaction_id, entitlement_id),
      constraint entitlement_grants_subscription_owner_fkey foreign key (subscription_id, user_id)
        references subscriptions (id, user_id) on delete restrict,
      constraint entitlement_grants_transaction_owner_fkey foreign key (transaction_id, user_id)
        references store_transactions (id, user_id) on delete restrict
    )`,
  sql`
    create index entitlement_grants_user_active_idx
      on entitlement_grants (user_id, entitlement_id)
      where revoked_at is null`,
];

const downStatements: RawBuilder<unknown>[] = [
  sql`drop table entitlement_grants`,
  sql`drop table subscription_events`,
  sql`drop table store_transactions`,
  sql`drop table subscriptions`,
  sql`drop table store_products`,
  sql`drop table product_entitlements`,
  sql`drop table products`,
  sql`drop table entitlements`,
  sql`drop table app_users`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of upStatements) {
    await statement.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const statement of downStatements) {
    await statement.execute(db);
  }
}
