# ADR-001: Technology stack

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

The platform verifies purchases from Apple and Google, processes signed webhooks idempotently,
runs a subscription state machine under concurrent delivery, and serves an admin dashboard. The
main correctness risks are transactional: row locking, unique-constraint idempotency, and keeping
queued work consistent with committed data. The codebase is a portfolio project, so readability
and low ceremony matter as much as capability. Development happens on Windows; CI and deployment
run on Linux.

## Decision

| Concern         | Choice                                                       | Pinned in M0            |
| --------------- | ------------------------------------------------------------ | ----------------------- |
| Runtime         | Node.js 24 LTS                                               | `.nvmrc`, `engines`     |
| Language        | TypeScript, strict                                           | 6.0.3                   |
| HTTP            | Fastify, plain modules                                       | added in M2             |
| Validation      | Zod at every boundary                                        | 4.6.7                   |
| Database        | PostgreSQL 16                                                | `postgres:16.15-alpine` |
| Data access     | Kysely and its migrator                                      | added in M1             |
| Background jobs | graphile-worker (Postgres-backed)                            | added in M3             |
| Admin UI        | React, Vite, TanStack Query                                  | added in M5             |
| Tests           | Vitest; Testcontainers; Playwright                           | Vitest 5.0.5            |
| Lint and format | ESLint (typescript-eslint strict, type-checked) and Prettier | ESLint 10, Prettier 3   |
| Logging         | pino with redaction                                          | added in M2             |
| Monorepo        | npm workspaces                                               | npm 10                  |
| CI              | GitHub Actions; gitleaks for secret scanning                 | gitleaks 8.30.1         |

## Rationale and trade-offs

- **TypeScript on Node** keeps one language across the API, worker and dashboard. Apple publishes
  an MIT-licensed Node library for App Store Server API and JWS verification, and Google maintains
  `googleapis`. _Rejected:_ Go, which has a leaner runtime but would mean two languages and weaker
  Apple tooling.
- **Fastify over NestJS.** Fastify gives raw-body access for signature checks, schema validation and
  little ceremony. NestJS's DI container and decorators add structure this project does not need.
  The cost is that module boundaries are a convention we document rather than a framework rule.
- **Kysely over an ORM.** Queries read as SQL, transactions are explicit, and
  `SELECT … FOR UPDATE` is first-class. _Rejected:_ Prisma, where row locking needs raw SQL;
  Drizzle was a close alternative.
- **graphile-worker over BullMQ.** Jobs are rows in PostgreSQL, so a job is enqueued in the same
  transaction as the webhook that caused it. That gives transactional-outbox guarantees without
  Redis. Throughput is lower than Redis-based queues but far above this system's needs.
- **Real PostgreSQL in integration tests (Testcontainers)** rather than mocks, because locking and
  constraint behaviour are exactly what must be verified.
- **Apple JWS chain validation uses Apple's official library.** Hand-rolled X.509 chain and OID
  checks are a common source of security bugs. Our code owns the mapping, the state machine and the
  `bundleId` / environment checks.
- **Node.js 24, not 22.** Node 22 is in maintenance LTS and reaches end of life on 2027-04-30,
  likely before this project is finished; Node 24 is the active LTS. Every pinned dependency's
  `engines` range accepts Node 24, and `@types/node` is pinned to the 24.x line to match.
- **TypeScript 6.0, not 7.** TypeScript 7 is current, but typescript-eslint 8.72 supports
  `>=4.8.4 <6.1.0`. Revisit when typed linting supports 7.
- **gitleaks runs as a checksum-verified release binary**, not via `gitleaks-action`, to avoid that
  action's licence requirement for organisation accounts and to pin the exact binary.
- **GitHub Actions are pinned to commit SHAs** with the version tag in a comment.
- **LF line endings everywhere** (`.gitattributes`, `.editorconfig`, Prettier) so Windows
  checkouts match Linux CI and containers.

## Consequences

- Docker is required for local PostgreSQL and for integration tests from M1 onward.
- The single stateful dependency is PostgreSQL, which simplifies local development, CI and hosting.
- Upgrading TypeScript to 7 waits on the typescript-eslint peer range.
