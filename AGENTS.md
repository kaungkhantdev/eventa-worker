# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Codex, …) working in this
repository — the single source of truth; tool-specific files import it.

## What this is

`eventa-worker` — the **asynchronous consumer service** for **Eventa**, a Thai-market (THB/satang,
VAT 7%, PromptPay, Asia/Bangkok, bilingual EN/TH) multi-tenant event platform. It **consumes RabbitMQ
messages** that `eventa-api` writes to its transactional **outbox** and `eventa-relay` publishes to the
broker (the api writes the outbox row and never publishes), and performs the **side effects** that must
never sit on the checkout critical path — today **email and SMS**, plus the clock-driven sweeps below.
Calendar invites, read-model/projection builders and search indexing are **not built here yet**. It does
**not** own the write model or the checkout/money path — those live in `eventa-api`.

**Built and merged to `develop`** (the foundation landed on `feat/worker-foundation`; that branch is
history): zod-validated config, pino logging, a global Drizzle `DatabaseModule` (typed **mirrors** of the
17 agreed tables under `src/db/schema/` — audit · orders · payments · seat-holds · events · tickets ·
messaging · outbox · announcements — **eventa-api owns the schema/migrations**), a Redis
`IdempotencyService`, and the RabbitMQ layer — `RabbitConnection` (**amqplib directly**, not
`@nestjs/microservices`, to interoperate with the outbox's topic-exchange + routing keys) plus
`ConsumerService` (asserts a topic exchange + queue + DLX/DLQ + the delay queues of a retry ladder,
discovers handlers via `DiscoveryService`, dispatches by routing key with dedupe on the *completed*
message id — recorded only after the handler succeeds, so an interrupted run is re-processed, not
skipped — tolerant-reader zod validation, and nack→retry→DLQ).

**Handlers today — all 18 of them, in 16 flat modules under `src/modules/` (this list is exhaustive; keep
it that way):** `access/member-invited` · `account-deletion/account-deletion-requested` ·
`auth/signed-in` (sign-in audit) · `auth-password/{password-reset,password-changed}` ·
`auth-signup/email-verification` · `auth-two-factor/two-factor-disabled` ·
`event-program/session-changed` · `events/{event-published,event-cancelled,attendees-email}` ·
`invitations/invitation-sent` · `payments/refund-required` ·
`registration/{registration-confirmed,registration-rejected}` · `users/email-change` ·
`waitlist/{waitlist-offered,waitlist-offer-expired}`. `registration/registration-confirmed` is the
ticket-bearing confirmation email (US-MSG-01) — the first bilingual EN/TH content, and the first handler
to read RLS-scoped tables via `db/tenant.ts`. On top of the handlers there are **three clock-driven jobs**
(see the write exception below). HTTP surface: health probes at `/health/{live,ready}` and the Prometheus
scrape at `/metrics`. Installed stack: `amqplib`, `ioredis`, `drizzle-orm`/`pg`, `@nestjs/config`,
`@nestjs/schedule`, `zod`, `nestjs-pino`/`pino`, `nodemailer` (SMTP email), `prom-client` (metrics). New
consumers = a `ValidatedHandler` subclass in a domain module (no wiring needed — DiscoveryService finds
it).

The build plan is **not in this repo** — it lives in the sibling SDLC docs at **`../eventa-docs`**. Read
these before adding anything:
- [`../eventa-docs/05-development/development-guide.md`](../eventa-docs/05-development/development-guide.md) — §2 (worker layout), §8 (async & messaging in code). **Primary reference.**
- [`../eventa-docs/04-architecture/software-architecture.md`](../eventa-docs/04-architecture/software-architecture.md) — the SAD; §6.3/§7.2 cover the outbox → RabbitMQ → consumer flow, and §11 holds the ADRs (ADR-13 idempotent consumers, **ADR-14** the scheduled-job write exception).
- [`../eventa-docs/04-architecture/entities.md`](../eventa-docs/04-architecture/entities.md) — the data model; this service may write only **agreed read-model tables** (api owns the schema), plus the ADR-14 write exception enumerated below.
- [`../eventa-docs/08-maintenance/devops-observability-sre.md`](../eventa-docs/08-maintenance/devops-observability-sre.md) — the SRE signals this service must emit (queue depth, outbox lag, handler success/failure).

Polyrepo siblings: `../eventa-api` (owns the DB schema/migrations and writes the outbox rows this service
ends up consuming — it never publishes), `../eventa-relay` (the outbox → RabbitMQ publisher, single
replica — **nothing reaches this service without it**, and its absence is silent), `../eventa-web` (React
front-end), `../eventa-ui-kit` (static HTML/Tailwind UI kit), `../eventa-infra` (Helm charts + Argo CD
today; Terraform is still planned).

**The write exception (ADR-14): three clock-driven jobs, and the four api-owned tables they write.** An
unpaid checkout leaves a `pending` order and a lapsed hold behind, a scheduled announcement falls due, a
reminder is owed the day before an event — and no message can announce the passage of time. So the jobs
here are driven by `@nestjs/schedule` rather than by a routing key, and they write eventa-api aggregates
rather than read models:
- `modules/order-expiry` (`@Cron` every minute, US-DISC-05) — `orders`, `seat_holds`, and `outbox_events`
  when a lapsed offer passes to the next person on the waitlist (US-REG-04);
- `modules/scheduled-announcements` (every minute, US-MSG-04/05) — `announcements` (`scheduled` → `sent`,
  or `cancelled` when its event is gone) and `outbox_events` for the broadcast that delivers it;
- `modules/scheduled-messages` (hourly, US-MSG-01/08) — `event_message_runs`, the per-event send claim
  that eventa-api never writes at all.
Keeping the schedule out of the HTTP API was deliberate; the cost is that `orders`, `seat_holds`,
`announcements` and `outbox_events` in `db/schema` are now **write** mirrors, so a missing enum value fails
a write instead of being silently absent from a read. When eventa-api changes one of those tables' enums,
change it here in the same breath. (The append-only logs `audit_events` and `message_deliveries` are
writes too, but they are this service's own send/audit record, not an aggregate.) The exception is
enumerated **per table** in [`../eventa-docs/04-architecture/entities.md`](../eventa-docs/04-architecture/entities.md)
— do not write a table that is not listed there without agreeing it first.

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
pnpm typecheck         # tsc --noEmit over src + test — the only type check the specs get
pnpm format            # prettier --write
pnpm test              # jest unit tests
pnpm test:e2e          # jest e2e tests (separate config)
pnpm test:cov          # coverage
pnpm email:doctor      # scripts/email-doctor.sh — walks api → outbox → relay → RabbitMQ → worker → SMTP
```

Run a **single test**: `pnpm test -- <path-or-name-pattern>` — e.g. `pnpm test -- consumer.service` or
`pnpm test -- -t "processes a new message"`. Same pattern for e2e: `pnpm test:e2e -- <pattern>`.
(There is no `app.controller` here — the HTTP surface is `health/` + `metrics/`.)

## Test-driven development (must follow)

**TDD is mandatory — no production code without a failing test that required it.** Write the failing test
**first**, then the minimal code to pass, then refactor with the suite green. For a consumer the tests that
matter most are: **idempotency** (the same message delivered twice produces one effect), **tolerant-reader
validation** (malformed / unknown-field / wrong-`version` payloads are handled, not crashed on), and the
**ack / nack→retry→DLQ** decision. The event shapes you consume are pinned by each handler's own zod
schema plus the `test/*.e2e-spec.ts` runs that publish a real message through the docker stack. **Pact is
not set up in this repo** — there is no `test/contract/` directory and no pact dependency — so treat the
docs' Pact plan as unbuilt rather than as something you can run or extend. Keep the suite green before
every commit and PR.

## Config specifics & gotchas

- **Two separate jest configs.** Unit config is inline in `package.json` (`rootDir: src`, matches
  `*.spec.ts`) — put fast tests beside the code. E2e is `test/jest-e2e.json` (`rootDir: .`, matches
  `*.e2e-spec.ts`) — put full-flow tests in `test/`. **Neither one type-checks:** `tsconfig.json` sets
  `isolatedModules: true`, which puts ts-jest in transpile-only mode, and `tsconfig.build.json` excludes
  the specs — so a spec can go green while it no longer compiles. `pnpm typecheck` must be green before
  a commit.
- **ESLint is type-aware** (`recommendedTypeChecked` + `projectService`); `no-floating-promises` and
  `no-unsafe-argument` are **warnings** — heed them, message handlers are all async. `module: nodenext`,
  `target: ES2023`.
- `main.ts` boots a **minimal HTTP app** (health probes + the `/metrics` scrape); the **RabbitMQ
  consumer starts on application bootstrap** (`ConsumerService.onApplicationBootstrap`), not via a Nest
  microservice transport.
- **TypeScript is full `strict`**; `no-explicit-any` is off but the type-aware `no-unsafe-*` rules apply.
- The **12 e2e specs** in `test/` (`consumer`, `registration-confirmed`, `attendees-broadcast`,
  `attendees-broadcast-interruption`, `cancellation-language`, `cancellation-recipients`, `order-expiry`,
  `payment-receipt`, `scheduled-messages`, `scheduled-announcements`, `event-reminder-switch`,
  `waitlist-queue`) each need the **shared docker infra up** (`../eventa-api/docker-compose.yml`) with
  migrations applied — each publishes to its own isolated `*.test` exchange/queue, and `jest-e2e.json`
  pins `maxWorkers: 1` so they do not collide.
- Prettier: **single quotes, trailing commas everywhere**.

## Target architecture (from the docs — governs code you add; much of it is built already)

Follow the development guide when implementing. The rules that are easy to get wrong:

- **Modules mirror the api's domain names, but are handler-shaped.** `src/modules/<domain>/` uses the same
  bounded-context names as `eventa-api`: today `access`, `account-deletion`, `auth`, `auth-password`,
  `auth-signup`, `auth-two-factor`, `event-program`, `events`, `invitations`, `payments`, `registration`,
  `users`, `waitlist`, plus the job modules `order-expiry`, `scheduled-announcements`,
  `scheduled-messages`. (The development guide's `engagement/`, `meetings/` and `insights/` worker folders
  do **not** exist here, and no projection builder has been written yet.) Each event gets a handler + a zod
  schema, e.g. `registration/registration-confirmed.handler.ts` + `registration-confirmed.schema.ts`.
  **Do not** structure folders by capability (`handlers/`, `email/`) — channel clients are **injected**:
  `EmailProvider` from `src/common/email/`, `SmsProvider` from `src/common/sms/` (there is no
  `src/common/providers/` folder — that is the docs' name for a layout that was never built — and no
  calendar provider yet). Cross-cutting code lives in
  `src/common/{db,email,idempotency,logging,messaging,sms,time}`; tenant scoping is the
  `src/db/tenant.ts` helper and metrics are `src/metrics/` — there is no `common/tenancy/` or
  `common/telemetry/`.
- **Every handler is idempotent.** Messages can be redelivered; dedupe on the event/message id so a repeat
  delivery produces no second effect. **ack** on success; on failure **nack → retry → DLQ** (don't lose or
  hot-loop a poison message).
- **Tolerant reader.** Validate every message with its zod schema; ignore unknown fields; payloads carry a
  `version` for breaking-change overlap. Never trust the wire shape.
- **This service does not own the schema.** It may write only **agreed read-model / log tables** plus the
  four ADR-14 aggregate tables listed above; all migrations live in `eventa-api`. Don't add migrations
  here.
- **Carry tenant + correlation context off the message.** Scope every read-model write by the message's
  `organization_id`; propagate the correlation id (originated in the api's HTTP request, passed through the
  RabbitMQ message) into logs and OpenTelemetry spans on each handler.
- **Money is integer satang**; time is UTC; user-facing strings (emails/SMS) are bilingual **EN/TH**.
- **Observability:** emit the SRE signals the Stage 8 doc consumes — queue depth, consumer lag, handler
  success/failure, retry/DLQ counts — plus OTel spans per message handler. Today that is **Prometheus
  only** (`prom-client` → `MetricsService` → `GET /metrics`): **no OpenTelemetry SDK is installed**, so the
  span half is still a target and the correlation id travels through the pino logs.

## Engineering standards (house rules — apply to all code you add)

Built for long-term maintainability. **Priority order** (never sacrifice architecture for short-term
speed): **Correctness → Maintainability → Readability → Testability → Performance → DX.** The canonical,
exhaustive version is [development-guide.md → Appendix A](../eventa-docs/05-development/development-guide.md);
this is the enforced summary, tailored to the consumer service. (Stack-adapted — Drizzle, not TypeORM.)

**SOLID & responsibilities**
- **Single Responsibility** — one job per class: `*.handler` = decode/validate/delegate/ack; service =
  workflow orchestration; repository = DB access (read models, plus the ADR-14 writes listed above);
  provider = a channel (email/sms); `*.schema` = message validation. Never mix.
- **Dependency Inversion** — handlers/services depend on **abstractions**: the injected `EmailProvider`
  (`common/email`) and `SmsProvider` (`common/sms`) ports and repository classes, never on concrete
  SMTP/AMQP/DB clients.
- **Open/Closed** — extend via strategy/polymorphism (e.g. a provider registry), not long `if/else`.

**Structure & layering**
- **Feature-first, never layer-first** — `src/modules/<name>/` mirrors the api's module names; a module owns
  its `*.handler` · `*.schema` · service · repository. **Never** top-level `handlers/`·`services/` folders;
  channel clients live in `common/email` · `common/sms`, injected. The full layout and rules are in
  **Creating a module** below; follow it whenever you add one.

- **Thin handlers** — a handler only: parse → **validate (tolerant reader / zod)** → delegate → ack; on
  failure nack → retry → DLQ. **No business logic** inline.
- **Services orchestrate**; **repositories** do only agreed read-model access, plus the ADR-14 writes
  enumerated above (this service does **not** own the schema — `eventa-api` does).
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

**3. One module = one concern, but handlers that share state stay together.** `attendees-email` and
`event-cancelled` share `EventRecipientsRepository` + `deliverToEach`, so they live in one `events/`
module, alongside `event-published` (which only validates and logs the notice until a workspace-members
read model exists). Extra descriptively-named files inside a module are fine. Sharing a repository
**across** modules goes through DI, never a reach-in: `EventsModule` **exports**
`EventRecipientsRepository`, and the six modules that read attendees the same way — `event-program`,
`invitations`, `payments`, `registration`, `scheduled-messages`, `waitlist` — declare
`imports: [EventsModule]`. Injecting another module's repository without that export is the thing to
avoid.

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
  nested ternaries, deep nesting. Full `strict` is on, and `pnpm typecheck` holds the specs to it too.
- **Explicit names** (`OrderConfirmedHandler`, `EmailProvider`); avoid `Helper`/`Util`/`Manager`.

**Review checklist:** SRP/SOLID · no dup · no magic strings/numbers · tolerant-reader validation · idempotency
· meaningful exceptions · correlation-id propagation · no business logic in handlers · tests updated.

**When unsure** — prefer maintainability over clever code; **ask before architectural changes**; don't
refactor unrelated code while implementing a feature.

## Contract with `eventa-api` (no shared package)

Each side owns its event type. `eventa-api` (the **producer**) defines the payload and writes it to the
outbox, `eventa-relay` publishes it, and this service (the **consumer**) validates it with a local zod
schema. The docs plan **Pact consumer** tests in `test/contract/` to fail CI on drift, but **that is not
built here**: no `test/contract/` directory, no pact dependency, nothing in CI that compares the two
shapes. What actually catches drift today is the tolerant-reader zod schema (a dead-lettered message) and
the e2e specs. Payloads carry a `version` field so producer and consumer can overlap across a breaking
change.
