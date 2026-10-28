import type { Kysely } from 'kysely';
import type { Database, ProductType, Store } from '../db/schema.ts';

export interface StoreProductRef {
  store: Store;
  storeProductId: string;
  /** Google Play base plan; null for other stores. */
  basePlanId: string | null;
}

export interface CatalogueProduct {
  productId: string;
  sku: string;
  type: ProductType;
  entitlementKeys: string[];
}

/** Resolves a store's product identifier to an active catalogue product and what it unlocks. */
export async function findStoreProduct(
  db: Kysely<Database>,
  ref: StoreProductRef,
): Promise<CatalogueProduct | null> {
  const product = await db
    .selectFrom('store_products as sp')
    .innerJoin('products as p', 'p.id', 'sp.product_id')
    .select(['p.id', 'p.sku', 'p.type'])
    .where('sp.store', '=', ref.store)
    .where('sp.store_product_id', '=', ref.storeProductId)
    .where('sp.base_plan_id', 'is not distinct from', ref.basePlanId)
    .where('p.active', '=', true)
    .executeTakeFirst();

  if (product === undefined) {
    return null;
  }

  const entitlements = await db
    .selectFrom('product_entitlements as pe')
    .innerJoin('entitlements as e', 'e.id', 'pe.entitlement_id')
    .select('e.key')
    .where('pe.product_id', '=', product.id)
    .orderBy('e.key')
    .execute();

  return {
    productId: product.id,
    sku: product.sku,
    type: product.type,
    entitlementKeys: entitlements.map((e) => e.key),
  };
}
