import type { ColumnType, Generated } from 'kysely';
import type {
  RevocationReason,
  SubscriptionStatus,
  TransitionCause,
} from '../billing/lifecycle.ts';

/**
 * Row types for Kysely, written by hand to match migrations in ./migrations.
 * Integration tests check these against the migrated database.
 */

export type Store = 'apple' | 'google' | 'simulated';
export type StoreEnvironment = 'production' | 'sandbox';
export type ProductType = 'consumable' | 'non_consumable' | 'subscription';
export type TransactionKind = 'purchase' | 'renewal';
export type EventSource = 'verification' | 'webhook' | 'reconciliation' | 'admin';
export type GrantSource = 'subscription' | 'transaction' | 'manual';

type CreatedAt = ColumnType<Date, Date | undefined, never>;
type UpdatedAt = ColumnType<Date, Date | undefined, Date>;

export interface AppUsersTable {
  id: Generated<string>;
  external_id: string;
  created_at: CreatedAt;
}

export interface EntitlementsTable {
  id: Generated<string>;
  key: string;
  description: Generated<string>;
  created_at: CreatedAt;
}

export interface ProductsTable {
  id: Generated<string>;
  sku: string;
  type: ProductType;
  active: Generated<boolean>;
  created_at: CreatedAt;
}

export interface ProductEntitlementsTable {
  product_id: string;
  entitlement_id: string;
}

export interface StoreProductsTable {
  id: Generated<string>;
  product_id: string;
  store: Store;
  store_product_id: string;
  /** Google Play base plan; null for every other store. */
  base_plan_id: string | null;
  created_at: CreatedAt;
}

export interface SubscriptionsTable {
  id: Generated<string>;
  user_id: string;
  product_id: string;
  store: Store;
  environment: StoreEnvironment;
  /** Apple originalTransactionId or Google purchaseToken. */
  store_subscription_key: string;
  status: SubscriptionStatus;
  auto_renew: boolean;
  current_period_start: Date;
  expires_at: Date;
  grace_expires_at: Date | null;
  revoked_at: Date | null;
  revocation_reason: RevocationReason | null;
  last_observed_at: Date;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface StoreTransactionsTable {
  id: Generated<string>;
  user_id: string;
  product_id: string;
  subscription_id: string | null;
  store: Store;
  environment: StoreEnvironment;
  store_transaction_id: string;
  kind: TransactionKind;
  purchased_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revocation_reason: RevocationReason | null;
  /** Price in millionths of the currency unit. Parsed as bigint; never a float. */
  price_micros: bigint | null;
  currency: string | null;
  acknowledged_at: Date | null;
  consumed_at: Date | null;
  /** Decoded payload exactly as verified, kept for audit. */
  verified_payload: ColumnType<unknown, string, string>;
  created_at: CreatedAt;
}

export interface SubscriptionEventsTable {
  id: Generated<bigint>;
  subscription_id: string;
  cause: TransitionCause;
  from_status: SubscriptionStatus | null;
  to_status: SubscriptionStatus;
  source: EventSource;
  observed_at: Date;
  recorded_at: CreatedAt;
}

export interface EntitlementGrantsTable {
  id: Generated<string>;
  user_id: string;
  entitlement_id: string;
  source: GrantSource;
  subscription_id: string | null;
  transaction_id: string | null;
  starts_at: Date;
  ends_at: Date | null;
  revoked_at: Date | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface Database {
  app_users: AppUsersTable;
  entitlements: EntitlementsTable;
  products: ProductsTable;
  product_entitlements: ProductEntitlementsTable;
  store_products: StoreProductsTable;
  subscriptions: SubscriptionsTable;
  store_transactions: StoreTransactionsTable;
  subscription_events: SubscriptionEventsTable;
  entitlement_grants: EntitlementGrantsTable;
}
