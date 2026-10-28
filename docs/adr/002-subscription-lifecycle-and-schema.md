# ADR-002: Subscription lifecycle model and schema conventions

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

M1 introduces the subscription state machine and the first database schema. Apple and Google
deliver notifications late, more than once and out of order, and Google's notifications carry no
subscription state at all. The architecture ([design rule 1](../architecture.md#design-rules))
already treats a notification as a trigger to fetch the authoritative state. This ADR fixes how
that state is applied, and the conventions the schema follows.

## Decisions

### 1. Reconcile complete snapshots, and name the change

The reducer takes the persisted state and a complete, verified snapshot, never an event delta. It
classifies the difference into named causes (`renewed`, `billing_failed`, `refunded`, …) using an
explicit transition table, and rejects pairs the table does not allow.

- _Why snapshots:_ with deltas, an out-of-order delivery can silently lose information (a renewal
  processed after a later cancellation would be dropped as stale, leaving the old expiry). A
  complete snapshot makes "newest wins" safe.
- _Why named causes:_ the admin timeline, metrics and audits need to know _why_ a state changed,
  and an explicit table makes impossible changes visible instead of silently applying them.
- _Rejected:_ applying the store's state unconditionally. It is simpler, but a mapping bug or a
  contradictory payload would then be stored without anyone noticing.

### 2. Access is a function of state and time

`isEntitled(state, now)` returns true only before the end of the period (or grace period). Access
lapses even when an expiry notification never arrives, so a lost webhook cannot extend access.

### 3. Refunds are attributes of a transaction, not new rows

The architecture listed `refund` and `revoke` as transaction kinds. Apple reports a refund by
setting `revocationDate` on the **existing** transaction, so a separate row would collide with the
`(store, environment, store_transaction_id)` uniqueness that provides idempotency.
`store_transactions` therefore has `kind in ('purchase', 'renewal')` plus `revoked_at` and
`revocation_reason`.

### 4. Schema conventions

- Closed value sets are `text` with **named** CHECK constraints, not PostgreSQL enum types, so a
  value can be added in an ordinary transactional migration.
- Migrations write their literals out and never import application constants, so an applied
  migration never changes. An integration test checks that every status and cause in the code is
  accepted by the database.
- Every constraint is named, so errors map to a cause and tests can assert on it.
- The database repeats the reducer's invariants as CHECK constraints (for example, a grace period
  end exists exactly when the status is `grace_period`).
- Grants reference their source through `subscription_id` / `transaction_id` foreign keys with a
  CHECK that exactly the right one is set, rather than a polymorphic `source_id` without referential
  integrity.
- Rows that hang off a subscription or transaction repeat its `user_id` and reference it through
  a composite foreign key on `(id, user_id)`, so the database rejects a transaction or grant whose
  owner differs from the subscription's.
- `store_products` uses `unique nulls not distinct` (PostgreSQL 15+) so a missing Google base plan
  still counts as a value in uniqueness.
- `bigint` values (money in micros, identity ids) are parsed as JavaScript `bigint`, scoped to the
  application's pool.
- Only tables M1 needs exist. `webhook_events` arrives with M3 and the admin tables with M5.

### 5. Migrations are listed explicitly and run from TypeScript source

Migrations are registered in [`migrations/index.ts`](../../apps/api/src/db/migrations/index.ts)
rather than discovered on disk, so the same list works from source, from the build and in tests.
Node 24 strips TypeScript types natively. The codebase uses `.ts` import specifiers with
`rewriteRelativeImportExtensions` (rewritten to `.js` in the build) and `erasableSyntaxOnly`, so
`npm run db:migrate` runs without a loader or build step.

### 6. Integration tests use Testcontainers with a database per test file

A single PostgreSQL container (the same image as Compose) starts per run, and each test file
creates its own database. Tests stay isolated and can run in parallel, and nothing depends on a
developer's local database.

## Consequences

- Provider code (M2, M6, M7) must map store payloads into complete snapshots, including the
  store-signed time.
- A `rejected` snapshot needs an operational path, such as a failed webhook visible in the admin
  dashboard (M3, M5).
- Integration tests need Docker. CI runs them on every push and pull request.
