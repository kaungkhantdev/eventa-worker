#!/usr/bin/env bash
#
# Where did the email go?
#
# An email crosses four systems before it reaches an inbox, and a failure in any
# of them looks identical from the screen that asked for it: nothing arrives.
# This walks the chain in order and names the first stage that is broken, so the
# answer is a stage rather than a guess.
#
#   API ──writes──▶ outbox_events ──relay──▶ RabbitMQ ──worker──▶ SMTP
#     1                                2                 3          4
#
# Read-only: it queries, it never sends, purges, restarts or acknowledges.
#
# Usage:  pnpm email:doctor            — check the pipeline
#         pnpm email:doctor <address>  — and trace one recipient's recent mail
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

RECIPIENT="${1:-}"
PG_CONTAINER="${PG_CONTAINER:-eventa-postgres-1}"
MQ_CONTAINER="${MQ_CONTAINER:-eventa-rabbitmq-1}"

# Read config from .env without exporting it — nothing here should leak a
# password into the environment of anything this script runs.
env_value() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | tr -d '"' | tr -d "'"
}

WORKER_PORT="$(env_value PORT)"; WORKER_PORT="${WORKER_PORT:-3100}"
QUEUE="$(env_value RABBITMQ_QUEUE)"; QUEUE="${QUEUE:-eventa.worker}"
EMAIL_PROVIDER="$(env_value EMAIL_PROVIDER)"; EMAIL_PROVIDER="${EMAIL_PROVIDER:-log}"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$OFF" "$1"; FAILED=1; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$OFF"; }
step() { printf '\n%s\n' "$1"; }

FAILED=0
psql_q() { docker exec "$PG_CONTAINER" psql -U eventa -d eventa -tAc "$1" 2>/dev/null; }

# ── 1. Postgres, and the outbox the API writes into ──────────────────────────
step "1. Outbox — did the API record anything to send?"
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
  bad "Postgres container '$PG_CONTAINER' is not running — start it with docker compose up -d"
else
  UNPUBLISHED="$(psql_q "SELECT count(*) FROM outbox_events WHERE published_at IS NULL")"
  ok "Postgres up"
  if [ "${UNPUBLISHED:-0}" -gt 0 ]; then
    bad "$UNPUBLISHED event(s) written but never published — the RELAY is not running"
    note "start it: cd ../eventa-relay && pnpm start:dev"
  else
    ok "every recorded event has been published to RabbitMQ"
  fi
fi

# ── 2. RabbitMQ, and whether anything is listening on the work queue ─────────
step "2. RabbitMQ — is the queue moving, and is anyone consuming it?"
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$MQ_CONTAINER"; then
  bad "RabbitMQ container '$MQ_CONTAINER' is not running — start it with docker compose up -d"
else
  ok "RabbitMQ up"
  STATS="$(docker exec "$MQ_CONTAINER" rabbitmqctl list_queues name messages consumers 2>/dev/null \
           | awk -v q="$QUEUE" '$1 == q { print $2, $3 }')"
  READY="$(echo "$STATS" | awk '{print $1}')"
  CONSUMERS="$(echo "$STATS" | awk '{print $2}')"
  if [ -z "$STATS" ]; then
    warn "queue '$QUEUE' does not exist yet — it is declared when the worker first starts"
  elif [ "${CONSUMERS:-0}" -eq 0 ]; then
    bad "queue '$QUEUE' has NO consumer — the worker is not attached (${READY:-0} message(s) waiting)"
    note "this is the failure that looks exactly like 'email is slow': mail queues and nobody sends it"
  else
    ok "$CONSUMERS consumer(s) attached to '$QUEUE'"
    [ "${READY:-0}" -gt 0 ] \
      && warn "${READY} message(s) still waiting — the worker may be busy, stuck or failing" \
      || ok "queue is drained"
  fi
  DLQ="$(docker exec "$MQ_CONTAINER" rabbitmqctl list_queues name messages 2>/dev/null \
         | awk -v q="$QUEUE.dlq" '$1 == q { print $2 }')"
  [ "${DLQ:-0}" -gt 0 ] && warn "$DLQ message(s) in the dead-letter queue — these were given up on" \
                        || ok "dead-letter queue empty"
fi

# ── 3. The worker's own view of its dependencies ─────────────────────────────
step "3. Worker — is the process healthy, and still connected?"
READY_JSON="$(curl -s -m 5 "http://localhost:$WORKER_PORT/health/ready" 2>/dev/null)"
if [ -z "$READY_JSON" ]; then
  bad "worker is not answering on :$WORKER_PORT — it is not running"
  note "start it: pnpm start:dev"
else
  case "$READY_JSON" in
    *'"rabbitmq":"up"'*) ok "worker says its RabbitMQ connection is up" ;;
    *'"rabbitmq":"down"'*)
      bad "worker is RUNNING but its RabbitMQ connection is DOWN — it consumes nothing"
      note "/health/live still says ok, which is why nothing looked wrong; restart the worker" ;;
    *) warn "unrecognised health response: $READY_JSON" ;;
  esac
  case "$READY_JSON" in
    *'"database":"up"'*) ok "worker database connection up" ;;
    *'"database":"down"'*) bad "worker cannot reach Postgres" ;;
  esac
fi

# ── 4. How mail actually leaves, once a handler runs ─────────────────────────
step "4. Delivery — where does a sent email actually go?"
if [ "$EMAIL_PROVIDER" = "log" ]; then
  warn "EMAIL_PROVIDER=log — mail is PRINTED to the worker log, never delivered"
  note "expected in local dev; set EMAIL_PROVIDER=smtp to send for real"
else
  SMTP_HOST="$(env_value SMTP_HOST)"
  ok "EMAIL_PROVIDER=smtp via ${SMTP_HOST:-unset}"
  note "a real send logs 'Email sent' with the provider's messageId; a refusal is rethrown and retried"
fi

# ── Optional: trace one recipient through stages 1 and 2 ─────────────────────
if [ -n "$RECIPIENT" ]; then
  step "Recent mail for $RECIPIENT"
  ROWS="$(psql_q "SELECT to_char(created_at,'MM-DD HH24:MI:SS') || '  ' || rpad(routing_key, 38) || '  ' ||
                    CASE WHEN published_at IS NULL THEN 'STUCK IN OUTBOX' ELSE 'published' END
                  FROM outbox_events
                  WHERE payload->>'email' = '$(printf '%s' "$RECIPIENT" | tr -d "'")'
                  ORDER BY id DESC LIMIT 10")"
  if [ -z "$ROWS" ]; then
    bad "no email was EVER queued for that address"
    note "the API never had anything to send — usually no account, or the other persona's realm"
  else
    printf '%s\n' "$ROWS" | sed 's/^/  /'
    note "'published' means it reached RabbitMQ — check the worker log for 'Email sent' to confirm delivery"
  fi
fi

# ── Verdict ──────────────────────────────────────────────────────────────────
if [ "$FAILED" -eq 1 ]; then
  printf '\n%sPipeline is broken — fix the ✗ above, highest one first.%s\n' "$RED" "$OFF"
  exit 1
fi
printf '\n%sPipeline is healthy.%s If mail is still missing it left this system:\n' "$GREEN" "$OFF"
printf '  check spam, and that the address has an account in the realm being asked.\n'
