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

## Engineering standards (house rules — apply to all code you add)

Built for long-term maintainability. **Priority order** (never sacrifice architecture for short-term
speed): **Correctness → Maintainability → Readability → Testability → Performance → DX.** The canonical,
exhaustive version is [development-guide.md → Appendix A](../eventa-docs/05-development/development-guide.md);
this is the enforced summary, tailored to the consumer service. (Stack-adapted — Drizzle, not TypeORM.)

**SOLID & responsibilities**
- **Single Responsibility** — one job per class: `*.handler` = decode/validate/delegate/ack; service =
  workflow orchestration; repository = read-model DB access; provider = a channel (email/sms/calendar);
  `*.schema` = message validation. Never mix.
- **Dependency Inversion** — handlers/services depend on **abstractions**: injected provider + repository
  interfaces (from `common/providers`), never on concrete SMTP/AMQP/DB clients.
- **Open/Closed** — extend via strategy/polymorphism (e.g. a provider registry), not long `if/else`.

**Structure & layering**
- **Feature-first** — `src/modules/<domain>/` mirrors the api's bounded contexts; a module owns its
  `*.handler` · `*.schema` · service · repository. **Never** top-level `handlers/`·`services/` layer folders;
  channel clients live in `common/providers`, injected.
- **Thin handlers** — a handler only: parse → **validate (tolerant reader / zod)** → delegate → ack; on
  failure nack → retry → DLQ. **No business logic** inline.
- **Services orchestrate**; **repositories** do only agreed read-model access (this service does **not** own
  the schema — `eventa-api` does).
- **DTOs/schemas at the edge** — validate every message with its zod schema; never trust the wire shape.

**Domain & correctness**
- **Idempotent handlers** — dedupe on event/message id; a redelivery produces no second effect.
- **Custom, meaningful exceptions**; **enums over magic strings**, **constants over magic numbers**.
- **Side effects run through injected providers** — the service *is* the side-effect path; keep the core of
  each handler focused and delegate email/SMS/calendar to providers.
- **Transactions** for multi-row read-model writes.

**Cross-cutting**
- **Config only via `ConfigService`** — never read `process.env` directly.
- **Logging via the Nest/pino `Logger`** — never `console.log`; propagate the **correlation id** off the
  message into logs/spans. Never log secrets/tokens.
- **DI budget** — >~6 injected deps is a smell; split. **No circular deps.**
- **Infrastructure behind adapters** — workflow code must not import SMTP/AMQP/DB clients directly.

**Methods, TypeScript, naming**
- **Small methods** — house target **≤ 10 lines**, ~40 hard ceiling; one level of abstraction each.
- **TypeScript** — `readonly`, async/await, optional chaining, nullish coalescing; avoid `any`, `@ts-ignore`,
  nested ternaries, deep nesting. *(tsconfig is only partly strict today — full `strict` is the target.)*
- **Explicit names** (`OrderConfirmedHandler`, `EmailProvider`); avoid `Helper`/`Util`/`Manager`.

**Review checklist:** SRP/SOLID · no dup · no magic strings/numbers · tolerant-reader validation · idempotency
· meaningful exceptions · correlation-id propagation · no business logic in handlers · tests updated.

**When unsure** — prefer maintainability over clever code; **ask before architectural changes**; don't
refactor unrelated code while implementing a feature.

## Contract with `eventa-api` (no shared package)

Each side owns its event type. `eventa-api` (the **producer**) defines the payload; this service (the
**consumer**) validates it with a local zod schema and pins expectations with **Pact consumer** tests in
`test/contract/` — CI fails on drift. Payloads carry a `version` field so producer and consumer can
overlap across a breaking change.
