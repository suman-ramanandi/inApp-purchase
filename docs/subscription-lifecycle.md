# Subscription lifecycle

How a subscription's state changes, and how those changes are persisted safely. The rules live in
[`apps/api/src/billing/lifecycle.ts`](../apps/api/src/billing/lifecycle.ts); the reasoning behind
the model is in [ADR-002](adr/002-subscription-lifecycle-and-schema.md).

## Inputs and outputs

`reconcile(current, snapshot)` is a pure function. It performs no I/O and never reads the clock.

- **`current`** is the persisted state from the `subscriptions` row, or `null` for a subscription
  seen for the first time. The database is the source of truth for this value.
- **`snapshot`** is the subscription's state as reported by the store **after a provider has
  verified it**: a signature-checked payload or a response from the store's server API. It carries
  `observedAt`, the store-signed time at which that state was produced. Prices, dates and statuses
  sent by a client app never reach the reducer unverified.

| Result      | Meaning                                                           | Caller's action                                          |
| ----------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `created`   | First sighting of this subscription                               | Insert the row and a `created` event                     |
| `updated`   | One or more named changes (`causes`)                              | Update the row and append one event per cause            |
| `unchanged` | Same state; only `lastObservedAt` advanced                        | Optionally persist `lastObservedAt`; no event            |
| `stale`     | Snapshot is older than the persisted state                        | Ignore it                                                |
| `rejected`  | Snapshot is invalid or contradicts the rules (`reason`, `detail`) | Do not apply; mark the triggering work failed for review |

## States

| State           | Grants access          | Meaning                                                      |
| --------------- | ---------------------- | ------------------------------------------------------------ |
| `active`        | until `expiresAt`      | Paid period in progress                                      |
| `grace_period`  | until `graceExpiresAt` | Renewal failed; the store keeps access while it retries      |
| `billing_retry` | no                     | Renewal failed and grace is over (Google calls this on hold) |
| `paused`        | no                     | Paused by the user (Google Play)                             |
| `expired`       | no                     | Ended without renewal                                        |
| `revoked`       | no                     | Refunded, or revoked for another reason                      |

Access is decided by `isEntitled(state, now)`, which compares `now` with the end of access. Access
therefore lapses on time even if the store's expiry notification is late or lost.

`autoRenew` is a separate flag. Turning it off (a cancellation) does not change the status: the
user keeps access until the period ends, and the status becomes `expired` after that.

## Allowed status changes

Rows are the persisted status, columns the snapshot's status. A dash is rejected with
`transition_not_allowed`.

| from \ to       | active          | grace_period   | billing_retry        | paused | expired         | revoked            |
| --------------- | --------------- | -------------- | -------------------- | ------ | --------------- | ------------------ |
| `active`        | ·               | billing_failed | billing_failed       | paused | expired         | refunded / revoked |
| `grace_period`  | recovered       | ·              | grace_period_expired | —      | expired         | refunded / revoked |
| `billing_retry` | recovered       | —              | ·                    | —      | expired         | refunded / revoked |
| `paused`        | resumed         | —              | billing_failed       | ·      | expired         | refunded / revoked |
| `expired`       | resubscribed    | —              | —                    | —      | ·               | refunded / revoked |
| `revoked`       | refund_reversed | —              | —                    | —      | refund_reversed | ·                  |

- Changes into `revoked` record `refunded` or `revoked` depending on the revocation reason.
- Leaving `revoked` is allowed only when the revocation was a refund (a refund reversal).
- `paused → billing_retry` follows Google Play: a failed payment when resuming goes straight to
  account hold. Google documents no path from paused to a grace period, so that change is rejected.
- Within the same status (`·`), the reducer records `renewed` when the period end advances,
  `auto_renew_disabled` / `auto_renew_enabled` when the flag changes, and `details_changed` for
  any other field change. Nothing changed gives `unchanged`.
- If the period end advanced and the new status is not one that starts a period (`recovered`,
  `resumed`, `resubscribed`, `refund_reversed`), `renewed` is recorded first. This covers a missed
  renewal followed by another change arriving as one snapshot, for example
  `['renewed', 'billing_failed']`.
- When the status changes, an auto-renew change in the same snapshot is not recorded separately.

## Rejections

| Reason                   | When                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_snapshot`       | Period ends before it starts; `graceExpiresAt` set outside `grace_period` (or missing in it); grace ends before the period; revocation set outside `revoked` (or missing in it); an invalid date                                                                                               |
| `transition_not_allowed` | The status pair is a dash in the table above                                                                                                                                                                                                                                                   |
| `period_regressed`       | The snapshot's `expiresAt` is earlier than the persisted one **and the snapshot still grants access**. A snapshot that grants none (refund, revocation, expiry, billing retry, pause) is accepted even when its period end moved back, so a contradictory end date can never keep access alive |

The database enforces the same invariants with CHECK constraints (`subscriptions_*` in
[`0001_core_domain.ts`](../apps/api/src/db/migrations/0001_core_domain.ts)), so a bug that bypasses
the reducer still cannot store an inconsistent row.

## Ordering

Snapshots are ordered by `observedAt`, the store's signed time, never by arrival time or the local
clock. A snapshot older than `lastObservedAt` is `stale` and ignored. One with the same
`observedAt` is applied. Because each snapshot is a complete state rather than a delta, ignoring an
older one loses nothing.

## Transactions and idempotency (applies from M2 and M3)

M1 provides the rules and the schema. The code that applies a snapshot arrives with the purchase
API (M2) and the webhook pipeline (M3), and must follow this sequence in **one transaction**:

1. `select … from subscriptions where store = $1 and environment = $2 and store_subscription_key = $3 for update`.
   The row lock serialises concurrent deliveries for the same subscription. For a first sighting,
   `insert … on conflict (store, environment, store_subscription_key) do nothing` and then lock the
   row, so two concurrent first deliveries cannot both create it.
2. Run `reconcile(current, snapshot)` on the locked row.
3. On `created` / `updated`: write the row, append one `subscription_events` row per cause, and
   recompute the subscription's `entitlement_grants` (one row per entitlement, upserted on
   `entitlement_grants_subscription_key`).
4. Commit. On `stale`, `unchanged` or `rejected`, commit without lifecycle changes.

Idempotency is enforced by the database rather than by checks in code:

| Duplicate                         | Guard                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| Same subscription seen twice      | `subscriptions_store_identity_key` plus the row lock; the reducer then returns `unchanged` |
| Same store transaction twice      | `store_transactions_store_identity_key` with `on conflict do nothing`                      |
| Grant recomputed twice            | `entitlement_grants_subscription_key` / `_transaction_key` upserts                         |
| Same webhook delivered twice (M3) | `UNIQUE(store, notification_id)` on `webhook_events`                                       |

Ownership is enforced the same way. A transaction attached to a subscription, and a grant derived
from a subscription or transaction, must carry that row's `user_id`: composite foreign keys on
`(subscription_id, user_id)` and `(transaction_id, user_id)` reject anything else. Binding a
store purchase to the right user in the first place (Apple `appAccountToken`, Google
`obfuscatedExternalAccountId`) is M2's job.
