import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';

/**
 * Entitlement keys a user holds at `now`: grants that have started, have not ended and are not
 * revoked. `now` is a parameter rather than the database clock so results are reproducible.
 */
export async function activeEntitlementKeys(
  db: Kysely<Database>,
  userId: string,
  now: Date,
): Promise<string[]> {
  const rows = await db
    .selectFrom('entitlement_grants as g')
    .innerJoin('entitlements as e', 'e.id', 'g.entitlement_id')
    .select('e.key')
    .distinct()
    .where('g.user_id', '=', userId)
    .where('g.revoked_at', 'is', null)
    .where('g.starts_at', '<=', now)
    .where((eb) => eb.or([eb('g.ends_at', 'is', null), eb('g.ends_at', '>', now)]))
    .orderBy('e.key')
    .execute();

  return rows.map((r) => r.key);
}
