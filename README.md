# In-App Purchase Platform

[![CI](https://github.com/suman-ramanandi/inApp-purchase/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/suman-ramanandi/inApp-purchase/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A backend and admin dashboard for verifying Apple App Store and Google Play purchases, tracking the
subscription lifecycle (renewals, cancellations, grace periods, billing retry, refunds and
revocations) and answering one question reliably: **which entitlements does this user have right
now?**

> **Status: milestone M1 (domain model and schema).** The repository contains the project
> foundation, the subscription lifecycle rules, the database schema and their tests. **There is no
> HTTP API, webhook handling or store integration yet**, so nothing can verify a real purchase. The
> sections below separate what is implemented from what is planned.

## What exists today

| Implemented in M0                                                                       | Location                                                                                                         |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| npm workspaces monorepo with strict TypeScript                                          | [`package.json`](package.json), [`tsconfig.base.json`](tsconfig.base.json)                                       |
| Linting (typescript-eslint, type-checked) and formatting (Prettier)                     | [`eslint.config.js`](eslint.config.js), [`.prettierrc.json`](.prettierrc.json)                                   |
| Environment config validation that never echoes secret values, with unit tests          | [`apps/api/src/config.ts`](apps/api/src/config.ts)                                                               |
| Local PostgreSQL 16 via Docker Compose, with a health check                             | [`docker-compose.yml`](docker-compose.yml)                                                                       |
| CI: lint, format check, typecheck, tests, gitleaks secret scan, Compose health check    | [`.github/workflows/ci.yml`](.github/workflows/ci.yml)                                                           |
| Dependabot config for npm and GitHub Actions (active once on the default branch)        | [`.github/dependabot.yml`](.github/dependabot.yml)                                                               |
| Architecture and decision records                                                       | [`docs/architecture.md`](docs/architecture.md), [`docs/adr/`](docs/adr/)                                         |
| **M1:** subscription lifecycle reducer (pure, deterministic) and time-based entitlement | [`apps/api/src/billing/lifecycle.ts`](apps/api/src/billing/lifecycle.ts)                                         |
| **M1:** PostgreSQL schema and migrations with named constraints, and a migration CLI    | [`apps/api/src/db/`](apps/api/src/db/)                                                                           |
| **M1:** catalogue lookup and active-entitlement queries                                 | [`apps/api/src/catalogue/`](apps/api/src/catalogue/), [`apps/api/src/entitlements/`](apps/api/src/entitlements/) |
| **M1:** integration tests against real PostgreSQL (Testcontainers)                      | [`apps/api/test/integration/`](apps/api/test/integration/)                                                       |

## What is planned

| Milestone | Scope                                                                                       |
| --------- | ------------------------------------------------------------------------------------------- |
| M2        | Client API with simulated purchase verification and per-user purchase binding               |
| M3        | Webhook pipeline: signature verification, idempotent storage, transactional jobs, retries   |
| M4        | Billing simulator: lifecycle scenarios, clock control, duplicate and out-of-order delivery  |
| M5        | Admin API and dashboard, audit log, end-to-end tests                                        |
| M6        | Apple App Store integration (StoreKit 2 transactions, App Store Server Notifications v2)    |
| M7        | Google Play integration (Play Developer API, Real-time Developer Notifications via Pub/Sub) |
| M8        | Reconciliation jobs and hardening                                                           |
| M9        | Production images and a public demo running in simulated mode                               |

Real Apple and Google integrations require developer accounts and credentials. Until then, they
are tested against fixtures, and the public demo uses the built-in simulator. See
[docs/architecture.md](docs/architecture.md#store-providers) for how the two modes differ.

## Prerequisites

- **Node.js 24 LTS** (the exact major is in [`.nvmrc`](.nvmrc)) and npm 10 or later
- **Git**
- **Docker Desktop** (Windows/macOS) or **Docker Engine with the Compose plugin** (Linux), for the
  local database and integration tests. Docker is not needed to run lint, typecheck or unit tests.

## Getting started

Clone the repository and install dependencies from the lockfile:

```sh
git clone https://github.com/suman-ramanandi/inApp-purchase.git
cd inApp-purchase
npm ci
```

Create your local environment file from the template. It contains placeholders only.

| Windows PowerShell            | Linux / macOS          |
| ----------------------------- | ---------------------- |
| `Copy-Item .env.example .env` | `cp .env.example .env` |

`DATABASE_URL` must stay consistent with the `POSTGRES_*` values in the same file. If you change
the user, password, port or database name, update both.

Run all checks:

```sh
npm run check
```

## Local database (Docker Compose)

Start PostgreSQL and wait until its health check passes:

```sh
docker compose up --detach --wait
docker compose ps        # STATUS should show "healthy"
```

Stop it, keeping data:

```sh
docker compose down
```

Stop it and delete the data volume:

```sh
docker compose down --volumes
```

Compose reads credentials from `.env` and refuses to start if any are missing. The port is bound to
`127.0.0.1` only, so the database is not reachable from other machines. These commands are the same
in PowerShell and in Linux shells.

## npm scripts

| Script                     | What it does                                                                    |
| -------------------------- | ------------------------------------------------------------------------------- |
| `npm run lint`             | ESLint with type-aware rules across all workspaces                              |
| `npm run format`           | Rewrites files with Prettier                                                    |
| `npm run format:check`     | Fails if any file is not Prettier-formatted (used in CI)                        |
| `npm run typecheck`        | `tsc --noEmit` for root config files and every workspace                        |
| `npm test`                 | Runs the unit tests once                                                        |
| `npm run test:integration` | Runs integration tests against a disposable PostgreSQL container (needs Docker) |
| `npm run db:migrate`       | Applies pending migrations to `DATABASE_URL` (read from `.env`)                 |
| `npm run db:migrate:down`  | Rolls back the most recent migration                                            |
| `npm run check`            | Runs lint, format check, typecheck and unit tests in sequence                   |

## Testing

Unit tests live next to the code they test as `*.test.ts` and run with [Vitest](https://vitest.dev):

```sh
npm test
npx vitest           # watch mode
```

Integration tests live in `apps/api/test/integration`. They start one PostgreSQL 16 container with
[Testcontainers](https://testcontainers.com), give each test file its own database, and check
migrations (apply, roll back, re-apply), every named constraint, idempotency keys and the queries.
They need Docker:

```sh
npm run test:integration
```

CI runs them on every push and pull request. End-to-end tests (Playwright) are planned for M5.

To apply the schema to the Compose database:

```sh
docker compose up --detach --wait
npm run db:migrate
```

## Continuous integration

[`ci.yml`](.github/workflows/ci.yml) runs on pushes to `main` and `develop` and on every pull
request:

- **checks**: `npm ci`, lint, format check, typecheck and unit tests on Node from `.nvmrc`.
- **integration**: integration tests against PostgreSQL in Testcontainers.
- **secret-scan**: downloads a pinned gitleaks release, verifies its SHA-256 checksum and scans the
  full Git history.
- **compose**: rejects missing credentials, starts PostgreSQL on a fresh volume, waits for it to
  become healthy, queries it from the host, and runs the migration CLI up, down and up again.

Actions are pinned to commit SHAs, the workflow token is read-only, and checkout does not persist
credentials.

## Documentation

- [Architecture](docs/architecture.md): system overview, design rules, subscription states, data
  model, API boundaries and milestones.
- [ADR-001: Technology stack](docs/adr/001-technology-stack.md): the chosen stack and the
  trade-offs behind it.
- [ADR-002: Subscription lifecycle and schema](docs/adr/002-subscription-lifecycle-and-schema.md):
  snapshot reconciliation, named transitions and schema conventions.
- [Subscription lifecycle](docs/subscription-lifecycle.md): states, the allowed-transition table,
  rejections, ordering, and the transaction and idempotency design.

## Security

- **Never commit credentials.** `.env`, private keys (`*.p8`, `*.p12`, `*.pem`, `*.key`) and
  service-account JSON files are git-ignored. Keep App Store Connect keys and Google service-account
  keys outside the repository and supply them through environment variables.
- `.env.example` must contain placeholders only.
- CI scans the full history with gitleaks on every push and pull request. To scan locally before
  pushing, install [gitleaks](https://github.com/gitleaks/gitleaks) and run
  `gitleaks git --redact .`
- Please report suspected vulnerabilities privately through GitHub's **Report a vulnerability**
  button on the repository's Security tab, not in a public issue.

## License

[MIT](LICENSE)
