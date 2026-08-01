# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`eventa-worker` — the **asynchronous consumer service** for **Eventa**, a Thai-market (THB/satang,
VAT 7%, PromptPay, Asia/Bangkok, bilingual EN/TH) multi-tenant event platform. It **consumes RabbitMQ
messages** that `eventa-api` publishes via its transactional **outbox**, and performs the **side effects**
that must never sit on the checkout critical path: email/SMS, calendar invites, read-model/projection
builds, search indexing. It does **not** own the write model or the checkout/money path — those live in
`eventa-api`.

**The foundation + first consumer are built** (on branch `feat/worker-foundation`): zod-validated config,
pino logging, a global Drizzle `DatabaseModule` (a typed *view* of `audit_events` — **eventa-api owns the
schema/migrations**), a Redis `IdempotencyService`, and the RabbitMQ layer — `RabbitConnection` (**amqplib
directly**, not `@nestjs/microservices`, to interoperate with the outbox's topic-exchange + routing keys)
plus `ConsumerService` (asserts a topic exchange + queue + DLX/DLQ, discovers handlers via
`DiscoveryService`, dispatches by routing key with dedupe on the *completed* message id — recorded only
after the handler succeeds, so an interrupted run is re-processed, not skipped — tolerant-reader zod
validation, and nack→DLQ). First handler: `modules/auth/signed-in.handler` writes the sign-in audit. Health probes at
`/health/{live,ready}`. Installed stack: `amqplib`, `ioredis`, `drizzle-orm`/`pg`, `@nestjs/config`, `zod`,
`nestjs-pino`. New consumers = a `ValidatedHandler` subclass in a domain module (no wiring needed —
DiscoveryService finds it).

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
- `main.ts` boots a **minimal HTTP app** (health probes only); the **RabbitMQ consumer starts on
  application bootstrap** (`ConsumerService.onApplicationBootstrap`), not via a Nest microservice transport.
- **TypeScript is full `strict`**; `no-explicit-any` is off but the type-aware `no-unsafe-*` rules apply.
- The integration test (`test/consumer.e2e-spec.ts`) needs the **shared docker infra up** (from
  `../eventa-api`) with migrations applied — it publishes to an isolated `*.test` exchange/queue.
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
- **Feature-first, never layer-first** — `src/modules/<name>/` mirrors the api's module names; a module owns
  its `*.handler` · `*.schema` · service · repository. **Never** top-level `handlers/`·`services/` folders;
  channel clients live in `common/providers`, injected. The full layout and rules are in **Creating a
  module** below; follow it whenever you add one.

- **Thin handlers** — a handler only: parse → **validate (tolerant reader / zod)** → delegate → ack; on
  failure nack → retry → DLQ. **No business logic** inline.
- **Services orchestrate**; **repositories** do only agreed read-model access (this service does **not** own
  the schema — `eventa-api` does).
- **DTOs/schemas at the edge** — validate every message with its zod schema; never trust the wire shape.

### Creating a module (follow this exactly — mirrors eventa-api)

**1. Name it after the api module whose events it consumes**, so the two repos line up 1:1. Modules are
**flat siblings** under `src/modules/` — never nested inside another module — and related ones share a
**prefix**: `auth` (`identity.signed_in`), `auth-signup` (`identity.email_verification_requested`),
`auth-password` (`identity.password_reset_requested`), `events` (the `events.*` family). When the api splits
a context, split the matching consumer here too.

**2. Lay it out like this** — `<name>.module.ts` plus one **descriptively named** handler per routing key
(the routing key, not the module, is what a handler is about), each paired with its schema:

```
src/modules/<name>/
├── <name>.module.ts          # wiring only; providers are plain
├── <event>.handler.ts        # one per routing key — thin: validate → delegate → ack
├── <event>.schema.ts         # the zod tolerant reader + the exported routing-key const
├── <name>.repository.ts      # agreed read-model access only (the API owns the schema)
└── <shared>.ts               # helpers shared by this module's handlers (e.g. broadcast-delivery)
```
Handlers are **not** registered with RabbitmqModule — `ConsumerService` discovers every provider that looks
like a `MessageHandler` via `DiscoveryService` and binds its `routingKey`. Just list it in `providers`.

**3. One module = one concern, but handlers that share state stay together.** The three `events.*` handlers
share `EventRecipientsRepository` + `deliverToEach`, so they live in one `events/` module — splitting them
would force one module to reach into another's repository. Extra descriptively-named files inside a module
are fine; cross-module repository access is not.

**4. Own your schema, tolerantly.** Each consumer declares its **own** zod schema — never import a type from
the api. Unknown fields are stripped, not rejected; `version` lets producer and consumer evolve apart. A
schema that rejects a valid api message dead-letters real traffic, so keep required fields to the ones you
actually use.

**5. Every handler is idempotent.** Record completion **after** the side effect (`markCompleted`), and for a
fan-out use `recipientLedger(messageId)` so a redelivery or DLQ replay delivers only the un-sent tail. See
`broadcast-delivery.ts` — claiming before the work, or deduping only at message level, silently drops the
tail of an interrupted run.

**6. Register it in `app.module.ts`** and write the module docstring: which routing keys it consumes and
which api context it mirrors.

**7. Ship it with tests (TDD).** `*.spec.ts` beside the handler (mock the ports); `test/*.e2e-spec.ts`
publishes a real message through the docker stack and asserts the effect — that is what proves the binding,
the DI graph and the dedupe actually work.

**Domain & correctness**
- **Idempotent handlers** — dedupe on event/message id; a redelivery produces no second effect.
- **Custom, meaningful exceptions**; **enums over magic strings**, **constants over magic numbers**.
- **No hard-coding** — never inline a literal that has a canonical home. Magic strings → enums / union
  constants; magic numbers (retry counts, TTLs, prefetch, backoff) → module-level `const`; queue,
  exchange, routing-key and DLQ names, Redis key prefixes, URLs, credentials → `ConfigService` (zod `Env`)
  or a shared constants module, **never** a bare string or `process.env` in handler code. Event **routing
  keys and payload field names come from the shared contract** (the producer's `*.event.ts` / the zod
  schema), never re-typed literals. If a literal appears twice, or carries meaning, name it once.
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
