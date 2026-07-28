# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`eventa-worker` — the **asynchronous consumer service** for **Eventa**, a Thai-market (THB/satang,
VAT 7%, PromptPay, Asia/Bangkok, bilingual EN/TH) multi-tenant event platform. It **consumes RabbitMQ
messages** that `eventa-api` publishes via its transactional **outbox**, and performs the **side effects**
that must never sit on the checkout critical path: email/SMS, calendar invites, read-model/projection
builds, search indexing. It does **not** own the write model or the checkout/money path — those live in
`eventa-api`.

Right now this repo is a **fresh NestJS 11 + TypeScript scaffold** — only `app.module/controller/service`
exist (a plain HTTP app) and no consumer code has been written yet. The only runtime deps installed are
Nest core + rxjs; the target stack (`@nestjs/microservices` + a RabbitMQ transport, `zod`, a Postgres
client for read-model writes) is **not installed yet**.

The build plan is **not in this repo** — it lives in the sibling SDLC docs at **`../eventa-docs`**. Read
these before adding anything:
- [`../eventa-docs/05-development/development-guide.md`](../eventa-docs/05-development/development-guide.md) — §2 (worker layout), §8 (async & messaging in code). **Primary reference.**
- [`../eventa-docs/04-architecture/software-architecture.md`](../eventa-docs/04-architecture/software-architecture.md) — the SAD; §6.3/§7.2 cover the outbox → RabbitMQ → consumer flow and ADRs.
- [`../eventa-docs/04-architecture/entities.md`](../eventa-docs/04-architecture/entities.md) — the data model; this service may write only **agreed read-model tables** (api owns the schema).
- [`../eventa-docs/08-maintenance/devops-observability-sre.md`](../eventa-docs/08-maintenance/devops-observability-sre.md) — the SRE signals this service must emit (queue depth, outbox lag, handler success/failure).

Polyrepo siblings: `../eventa-api` (owns the DB schema/migrations and **produces** the events this service
consumes), `../eventa-web` (React front-end), `eventa-infra` (Terraform/Helm/Argo CD).

**Framework docs:** NestJS — https://docs.nestjs.com/ (consult it for microservices/transporters,
module/provider/DI, and testing patterns rather than guessing).

## Commands

Package manager is **pnpm**.

```bash
pnpm install
pnpm start:dev         # watch dev server (nest start --watch)
pnpm build             # nest build → dist/  (nest-cli deleteOutDir wipes dist/ first)
pnpm start:prod        # node dist/main
pnpm lint              # eslint --fix (type-aware; also applies prettier)
pnpm format            # prettier --write
pnpm test              # jest unit tests
pnpm test:e2e          # jest e2e tests (separate config)
pnpm test:cov          # coverage
```

Run a **single test**: `pnpm test -- <path-or-name-pattern>` — e.g. `pnpm test -- app.controller` or
`pnpm test -- -t "acks on success"`. Same pattern for e2e: `pnpm test:e2e -- <pattern>`.

## Test-driven development (must follow)

**TDD is mandatory — no production code without a failing test that required it.** Write the failing test
**first**, then the minimal code to pass, then refactor with the suite green. For a consumer the tests that
matter most are: **idempotency** (the same message delivered twice produces one effect), **tolerant-reader
validation** (malformed / unknown-field / wrong-`version` payloads are handled, not crashed on), and the
**ack / nack→retry→DLQ** decision. Pin the event shapes you consume with **Pact consumer** tests
(`test/contract/`). Keep the suite green before every commit and PR.

## Config specifics & gotchas

- **Two separate jest configs.** Unit config is inline in `package.json` (`rootDir: src`, matches
  `*.spec.ts`) — put fast tests beside the code. E2e is `test/jest-e2e.json` (`rootDir: .`, matches
  `*.e2e-spec.ts`) — put full-flow tests in `test/`.
- **TypeScript is only partly strict.** `tsconfig.json` sets `strictNullChecks` but **not** full `strict`:
  `noImplicitAny` is `false` and eslint's `no-explicit-any` is **off** — looser than the development
  guide's "strict, no `any`" intent. Prefer explicit types; consider tightening before the code grows.
- **ESLint is type-aware** (`recommendedTypeChecked` + `projectService`); `no-floating-promises` and
  `no-unsafe-argument` are **warnings** — heed them, message handlers are all async. `module: nodenext`,
  `target: ES2023`.
- The scaffold currently boots a **plain HTTP app**; the target `main.ts` is a **consumer bootstrap**
  (NestJS microservice with a RabbitMQ transport), likely retaining a minimal HTTP surface only for k8s
  liveness/readiness probes.
- Prettier: **single quotes, trailing commas everywhere**.

## Target architecture (from the docs — governs code you add, but not yet built here)

Follow the development guide when implementing. The rules that are easy to get wrong:

- **Modules mirror the api's domain names, but are handler-shaped.** `src/modules/<domain>/` uses the same
  bounded-context names as `eventa-api` (`registration`, `payments`, `engagement`, `meetings`), plus
  `insights/` for read-model / projection builders. Each event gets a handler + a zod schema, e.g.
  `registration/order-confirmed.handler.ts` + `order-confirmed.schema.ts`. **Do not** structure folders by
  capability (`handlers/`, `email/`) — channel clients (email · SMS · calendar) are **injected from
  `src/common/providers/`**, never the folder layout. Cross-cutting concerns live in
  `src/common/{idempotency,tenancy,telemetry}`.
- **Every handler is idempotent.** Messages can be redelivered; dedupe on the event/message id so a repeat
  delivery produces no second effect. **ack** on success; on failure **nack → retry → DLQ** (don't lose or
  hot-loop a poison message).
- **Tolerant reader.** Validate every message with its zod schema; ignore unknown fields; payloads carry a
  `version` for breaking-change overlap. Never trust the wire shape.
- **This service does not own the schema.** It may write only **agreed read-model / projection tables**;
  all migrations live in `eventa-api`. Don't add migrations here.
- **Carry tenant + correlation context off the message.** Scope every read-model write by the message's
  `organization_id`; propagate the correlation id (originated in the api's HTTP request, passed through the
  RabbitMQ message) into logs and OpenTelemetry spans on each handler.
- **Money is integer satang**; time is UTC; user-facing strings (emails/SMS) are bilingual **EN/TH**.
- **Observability:** emit the SRE signals the Stage 8 doc consumes — queue depth, consumer lag, handler
  success/failure, retry/DLQ counts — plus OTel spans per message handler.

## Engineering principles (apply to all code you add)

- **Feature-first, not layer-first.** Organize by domain (mirroring the api's bounded contexts) — a module
  owns its `*.handler` · `*.schema` · service · repository together. Never add top-level technical-layer
  folders (`handlers/`, `services/`); channel clients live in `common/providers`, injected.
- **SOLID — especially SRP & Dependency Inversion.** One reason to change per class; a handler depends on
  **abstractions** — injected provider/repository interfaces (email/sms/calendar) — never on concretions.
- **Thin handlers · orchestration-focused services · data-only repositories.** A handler validates the
  message (tolerant reader) and delegates; services hold the workflow; repositories do **only** read-model
  access.
- **Keep domain/business logic out of infrastructure.** The workflow must not touch AMQP/SMTP/DB specifics
  directly — reach them through injected ports.
- **Side effects run through injected providers, idempotently.** This service *is* the side-effect path —
  keep each handler focused on decode → validate → delegate → ack, deduped on event id.
- **Small functions — aim for ≤ 10 lines.** Extract helpers; a function should read as a short list of
  intent-level steps.
- **One level of abstraction per function.** Don't mix high-level orchestration and low-level detail in the
  same function.

## Contract with `eventa-api` (no shared package)

Each side owns its event type. `eventa-api` (the **producer**) defines the payload; this service (the
**consumer**) validates it with a local zod schema and pins expectations with **Pact consumer** tests in
`test/contract/` — CI fails on drift. Payloads carry a `version` field so producer and consumer can
overlap across a breaking change.
