# Architecture

This document describes the **target** architecture of the In-App Purchase Platform: the design
that milestones build towards. Technology choices and their trade-offs are recorded in
[ADR-001](adr/001-technology-stack.md).

## Project status

**Milestones M0 (foundation) and M1 (domain and schema).** Everything below this section is design,
not implemented code, unless this table lists it as implemented.

| Area                                                                                    | Status                                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| npm workspaces, TypeScript, ESLint, Prettier, Vitest                                    | Implemented (M0)                                                              |
| Environment config validation (`apps/api/src/config.ts`)                                | Implemented (M0)                                                              |
| Local PostgreSQL via Docker Compose; CI (lint, typecheck, tests, gitleaks, Compose)     | Implemented (M0); Compose verified in CI only                                 |
| Subscription lifecycle reducer and entitlement timing (`billing/lifecycle.ts`)          | Implemented (M1); see [subscription-lifecycle.md](subscription-lifecycle.md)  |
| Schema and migrations for catalogue, users, subscriptions, transactions, events, grants | Implemented (M1); see [ADR-002](adr/002-subscription-lifecycle-and-schema.md) |
| Catalogue lookup and active-entitlement queries                                         | Implemented (M1)                                                              |
| Integration tests (Testcontainers PostgreSQL)                                           | Implemented (M1); run in CI                                                   |
| Code that applies snapshots in a transaction                                            | Designed (M1 docs); implemented with M2/M3                                    |
| HTTP API, worker, webhooks, simulator, admin, store providers                           | Planned (M2–M9); no code exists yet                                           |

## Purpose

A backend and admin dashboard that verifies Apple App Store and Google Play purchases, tracks the
subscription lifecycle (renewals, cancellations, grace periods, billing retry, refunds,
revocations) and answers one question reliably: _which entitlements does this user have right
now?_

## System overview

```
 Mobile app ──(StoreKit 2 / Play Billing)──▶ Apple / Google
     │  purchase proof (signed JWS / purchaseToken)
     ▼
 ┌──────────────── API (Fastify) ─────────────────┐        ┌──── Worker (graphile-worker) ─────┐
 │ /v1          client API (user JWT)             │        │ process-webhook                   │
 │ /v1          server-to-server API (API key)    │  same  │ reconcile-subscription (periodic) │
 │ /webhooks/*  store notifications (signature)   │──txn──▶│ poll-google-voided-purchases      │
 │ /admin/api   admin (session cookie + CSRF)     │enqueue │ retries with backoff, dead-letter │
 │ /simulator   simulated store (opt-in only)     │        └────────────────┬──────────────────┘
 └────────────────┬───────────────────────────────┘                         │
                  └──────────────── PostgreSQL ◀─────────────────────────────┘
                                        ▲
                         Admin SPA (React) ── /admin/api
```

The API and the worker are built from the same package and image and differ only in entrypoint.
PostgreSQL is the only stateful dependency; the job queue lives in it too.

## Design rules

1. **Store notifications are triggers, not truth.** A webhook is verified, stored and queued. The
   job then fetches the authoritative state from the store and reconciles against it. This makes
   out-of-order and duplicate delivery harmless, and it is mandatory for Google, whose
   notifications carry no subscription state.
2. **Lifecycle rules are a pure function.**
   `reconcile(current, verifiedSnapshot)` returns the next state and the named causes of the
   change (or `stale` / `rejected`). It performs no I/O and is unit-tested exhaustively. Everything
   around it is plumbing.
3. **One state change, one transaction.** Lock the subscription row (`SELECT … FOR UPDATE`), apply
   the reducer, write the subscription, append a `subscription_events` row, recompute the user's
   entitlement grants, commit. Concurrent deliveries for one subscription serialise on the lock.
4. **Idempotency is enforced by unique constraints**, not by application checks:
   `UNIQUE(store, notification_id)` for webhooks, `UNIQUE(store, environment, store_transaction_id)`
   for transactions, with `INSERT … ON CONFLICT DO NOTHING`.
5. **Jobs are enqueued inside the same transaction** as the row that caused them (transactional
   outbox without a separate outbox table), so a committed webhook always has a job.
6. **Purchases are bound to one user** via Apple `appAccountToken` / Google
   `obfuscatedExternalAccountId`. A transaction already owned by user A cannot be claimed by user B
   (409).
7. **The client is never trusted** for price, expiry or product; these come from verified store data.
8. **Money is `bigint` micros plus an ISO 4217 currency code.** No floating point.
9. **Secrets come from the environment only.** `.env.example` holds placeholders; logs redact
   tokens and signed payloads.

## Store providers

One interface, justified by three real implementations:

```ts
interface StoreProvider {
  verifyNotification(rawBody, headers): VerifiedNotification; // throws on a bad signature
  fetchSubscriptionSnapshot(key): StoreSnapshot; // authoritative current state
  verifyClientPurchase(input): StoreSnapshot;
}
```

|                | Simulated (public demo)                                                   | Apple                                                                                        | Google                                                                                         |
| -------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Account needed | None                                                                      | Apple Developer Program, app record, In-App Purchase key (`.p8`), issuer ID                  | Play Console, app on a testing track, Cloud project, service account, Pub/Sub topic            |
| Purchase proof | JWS signed by a local Ed25519 key                                         | StoreKit 2 `signedTransactionInfo` (JWS, x5c chain to Apple Root CA G3)                      | `purchaseToken` checked via `purchases.subscriptionsv2.get` / `products.get`                   |
| Webhook auth   | HMAC-SHA256 over `timestamp.body`, 5-minute window, constant-time compare | App Store Server Notifications v2 `signedPayload` JWS; `bundleId` and environment must match | Pub/Sub push OIDC JWT (issuer, audience, service-account email); `packageName` must match      |
| Notes          | Clock control and a chaos mode (duplicate/reordered delivery)             | Legacy `verifyReceipt` is not used                                                           | Purchases must be acknowledged within 3 days; refunds also polled via the Voided Purchases API |
| Testable in CI | Fully                                                                     | Mapping and logic, with fixtures signed by a test CA. Real sandbox requires credentials.     | Mapping and logic, with fixtures. Real calls require credentials.                              |

The simulator is mounted only when `SIMULATOR_ENABLED=true` and never alongside real-store mode.

## Subscription states

| State           | Entitled | Apple                                  | Google                                   |
| --------------- | -------- | -------------------------------------- | ---------------------------------------- |
| `active`        | yes      | SUBSCRIBED, DID_RENEW, REFUND_REVERSED | PURCHASED, RENEWED, RECOVERED, RESTARTED |
| `grace_period`  | yes      | DID_FAIL_TO_RENEW / GRACE_PERIOD       | IN_GRACE_PERIOD                          |
| `billing_retry` | no       | DID_FAIL_TO_RENEW (no grace)           | ON_HOLD                                  |
| `paused`        | no       | —                                      | PAUSED                                   |
| `expired`       | no       | EXPIRED, GRACE_PERIOD_EXPIRED          | EXPIRED                                  |
| `revoked`       | no       | REFUND, REVOKE                         | REVOKED, voided purchase                 |

`auto_renew` is a separate flag. Cancelling turns it off; access continues until `expires_at`.

## Data model

| Table                  | Purpose and key constraints                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `app_users`            | End users identified by the host app's `external_id` (unique).                                                                             |
| `entitlements`         | Capabilities such as `premium` (`key` unique).                                                                                             |
| `products`             | Internal catalogue: `sku` (unique), `type` (consumable, non_consumable, subscription).                                                     |
| `product_entitlements` | Which entitlements a product unlocks.                                                                                                      |
| `store_products`       | Store identifiers per product; unique `(store, store_product_id, base_plan_id)`.                                                           |
| `subscriptions`        | Current lifecycle state per store subscription; unique `(store, environment, store_subscription_key)`.                                     |
| `store_transactions`   | Every verified purchase and renewal, with refund/revocation as attributes; unique `(store, environment, store_transaction_id)`.            |
| `subscription_events`  | Append-only state-transition history with its cause; drives the admin timeline.                                                            |
| `entitlement_grants`   | Derived access windows (`starts_at`, `ends_at`, `revoked_at`) from a subscription, transaction or manual grant, referenced by foreign key. |
| `webhook_events` (M3)  | Raw inbound notifications and processing status; unique `(store, notification_id)` is the idempotency guard.                               |
| `admin_users` (M5)     | Admin accounts with argon2id password hashes and a role (viewer, support, admin).                                                          |
| `admin_sessions` (M5)  | Hashed session and CSRF tokens with expiry.                                                                                                |
| `audit_log` (M5)       | Append-only record of every admin write, with before/after values.                                                                         |
| `api_clients` (M2)     | Hashed API keys for server-to-server access.                                                                                               |

Effective entitlements are grants where `starts_at ≤ now < coalesce(ends_at, ∞)` and
`revoked_at IS NULL`: one indexed query, no cache to invalidate.

## API boundaries

| Surface          | Auth                                      | Endpoints                                                                                                       |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Client API       | User JWT (host app issuer, JWKS)          | `POST /v1/purchases/{apple,google,simulated}`, `GET /v1/me/entitlements`, `GET /v1/me/subscriptions`            |
| Server-to-server | API key                                   | `GET /v1/users/:externalId/entitlements`                                                                        |
| Webhooks         | Store signature on the raw body           | `POST /webhooks/{apple,google,simulated}`; 200 after store-and-enqueue, 401 on a bad signature (nothing stored) |
| Admin            | Session cookie, CSRF token, RBAC, audited | Users and timelines, manual grants, webhook list and replay, product catalogue, audit log                       |
| Simulator        | Enabled by configuration only             | Create purchases, trigger lifecycle events, advance the clock, chaos mode                                       |
| Operations       | None                                      | `GET /healthz`, `GET /readyz`                                                                                   |

## Repository layout

```
apps/api/        API and worker (TypeScript, Fastify, Kysely)
apps/admin/      Admin SPA (React, Vite)           — milestone M5
e2e/             Playwright end-to-end tests      — milestone M5
docs/            Architecture and ADRs
```

## Milestones

| #   | Scope                                                                                        |
| --- | -------------------------------------------------------------------------------------------- |
| M0  | Foundations: workspaces, TypeScript, lint/format, tests, Compose, CI, secret scanning, docs  |
| M1  | Schema, migrations, lifecycle reducer, entitlement calculation                               |
| M2  | Client API with simulated verification and user binding                                      |
| M3  | Webhook pipeline: verification, idempotent storage, transactional jobs, retries, dead-letter |
| M4  | Simulator: lifecycle scenarios, clock control, chaos mode                                    |
| M5  | Admin API and dashboard, audit log, Playwright E2E                                           |
| M6  | Apple integration                                                                            |
| M7  | Google integration                                                                           |
| M8  | Reconciliation jobs and hardening                                                            |
| M9  | Production images and public demo (simulated mode only)                                      |
