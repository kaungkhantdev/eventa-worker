# eventa-worker: one Dockerfile for every image of this service.
#
#   base       Node 24 and pnpm (Corepack). Every other stage starts here.
#   deps       all dependencies, installed from the lockfile
#   dev        deps + source, runs `pnpm dev`: the target the umbrella compose uses
#   build      deps + source, runs `nest build` → dist/
#   prod-deps  production dependencies only, installed in a clean stage
#   prod       base + prod-deps + dist/, as uid 1000. This is the LAST stage.
#
# The last stage is what a build without --target produces, so a plain build
# gives the production image:
#
#   docker build -t eventa-worker .                    # production
#   docker build --target dev -t eventa-worker:dev .   # watch mode (compose)
#   docker run --rm --read-only --env-file <file> -p 3100:3100 eventa-worker
#
# How this image keeps the twelve factors (https://12factor.net):
#   I    Codebase      one repo, one Dockerfile. The image built from a commit is
#                      the image every environment runs (eventa-infra promotes
#                      it by tag); environments differ only in their config.
#   II   Dependencies  a pinned base image, the pnpm version from package.json's
#                      "packageManager", `--frozen-lockfile`. The prod image
#                      holds production dependencies only; no compiler, no jest.
#   III  Config        the environment only. .dockerignore keeps every .env file
#                      out of every image, and the worker needs no file to boot:
#                      @nestjs/config reads .env only if one exists.
#   IV   Backing svcs  Postgres, RabbitMQ, Redis and SMTP are URLs and hosts in
#                      env (DATABASE_URL, RABBITMQ_URL, REDIS_URL, SMTP_*), so
#                      swapping one is a config change, not a rebuild.
#   V    Build/run     `build` compiles; `prod` copies the output and runs it.
#                      Nothing is compiled or installed when a container starts.
#   VI   Processes     stateless: the process writes nothing to its filesystem,
#                      so it runs under `docker run --read-only` and under
#                      eventa-infra's readOnlyRootFilesystem. State lives in the
#                      backing services; files are owned by root, not the app.
#   VII  Port binding  the worker serves its own HTTP (health probes, /metrics)
#                      on PORT, 3100 by default; EXPOSE documents it.
#   VIII Concurrency   one process type per image: the consumer and its clock
#                      jobs. Scale by running more replicas (eventa-infra's HPA).
#   IX   Disposability exec-form CMD, so node is PID 1 and gets SIGTERM itself;
#                      main.ts calls app.enableShutdownHooks(), which stops
#                      consuming and closes connections before exit. Boot is
#                      `node dist/main`: no install, no compile.
#   X    Dev/prod      `dev` and `prod` share the base image, the lockfile and
#                      this file; the umbrella compose runs the same backing
#                      service kinds (Postgres, RabbitMQ, Redis) as production.
#   XI   Logs          pino writes one JSON line per event to stdout; the
#                      platform collects it. No log files.
#   XII  Admin         the worker has no admin commands of its own. Schema
#                      migrations belong to eventa-api and run from its image.

# ─── base ────────────────────────────────────────────────────────────────────
# Debian (glibc), not Alpine (musl): native packages ship prebuilt binaries per
# libc, and the glibc ones are what CI's Ubuntu runner proves. Pinned to a full
# release so that rebuilding a commit gives the same Node; move it on purpose,
# in step with CI's node-version (24).
FROM node:24.22.0-bookworm-slim AS base

# pnpm via Corepack, which ships with Node 24. The shim reads "packageManager"
# from package.json, so the image runs the pnpm this repo pins (and CI uses)
# with no second copy of the version to keep in step. A build has nobody to
# answer a download prompt.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app

# ─── deps ────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Fetch the pinned pnpm now, at build time, so no container downloads it.
RUN corepack install

# The container must never install dependencies by itself. Before
# `pnpm <script>`, pnpm 11 checks node_modules against the lockfile and by
# default runs `pnpm install` when they differ. Under the umbrella compose the
# project directory is the read-only checkout, so that install would fail
# half-way with a file-system error. `error` stops with
# ERR_PNPM_VERIFY_DEPS_BEFORE_RUN instead, which means: dependencies changed,
# rebuild this image.
ENV pnpm_config_verify_deps_before_run=error

# Installed the way CI installs: frozen lockfile and pnpm 11's strict
# build-script policy (no dangerouslyAllowAllBuilds), so a dependency whose
# install script pnpm-workspace.yaml has not approved fails the build with
# ERR_PNPM_IGNORED_BUILDS instead of leaving a half-built node_modules.
# The pnpm store lives in a BuildKit cache, not in the image, so a rebuild
# after a dependency change only downloads what is new.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# ─── dev ─────────────────────────────────────────────────────────────────────
# Watch mode, for the umbrella eventa/docker-compose.yml. That compose
# bind-mounts the live source read-only over this snapshot, so a save on the
# host recompiles here as `pnpm dev` does on the host. The snapshot means the
# image also runs on its own. .dockerignore keeps out node_modules, dist and
# every .env file.
FROM deps AS dev
COPY . .
# Health probes and /metrics: PORT, 3100 by default.
EXPOSE 3100
CMD ["pnpm", "dev"]

# ─── build ───────────────────────────────────────────────────────────────────
# nest build → dist/. Only what it reads, so an edit to a test or a document
# does not invalidate the production build. tsconfig.build.json extends
# tsconfig.json and compiles src/ without the specs.
FROM deps AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ─── prod-deps ───────────────────────────────────────────────────────────────
# A clean install of "dependencies" alone. Pruning the full install would work
# too; installing afresh leaves no doubt that nothing from devDependencies (or
# their hoisted transitive packages) survives into production. The first two
# steps are the same instructions on the same parent as in `deps`, so BuildKit
# runs them once for both.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store

# ─── prod ────────────────────────────────────────────────────────────────────
# Compiled JavaScript and production dependencies, nothing else: no source, no
# TypeScript, no pnpm store, no .env. The files stay owned by root, so the
# process can read its code and cannot change it.
FROM base AS prod
# The default, so a bare `docker run` gets production's config rules (the
# worker refuses EMAIL_PROVIDER=log, for one). An environment may set another:
# eventa-infra's dev overlay sets development. Logs stay JSON either way.
# Pretty output needs pino-pretty, a devDependency this image does not have,
# and the logger checks that it is installed before asking pino for it
# (src/config/logger.config.ts).
ENV NODE_ENV=production
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# The node image's `node` user, by number: Kubernetes' runAsNonRoot can only
# verify a numeric user, and eventa-infra's pod securityContext runs as
# 1000:1000.
USER 1000:1000

# Health probes and /metrics: PORT, 3100 by default.
EXPOSE 3100

# For `docker run` and compose. Kubernetes ignores it and uses eventa-infra's own
# probes. /health/live answers 503 once the worker has lost its queue for
# longer than a broker blip, so this checks "consuming", not just "running".
# There is no curl or wget in the image; Node's fetch is enough.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3100) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exec form: node itself is PID 1, so SIGTERM reaches it (IX). `pnpm start:prod`
# would put pnpm in between and need it in the image.
CMD ["node", "dist/main"]
