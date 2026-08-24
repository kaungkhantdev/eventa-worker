/** First retry, and the floor: never a tight loop against a broker that is down. */
const BASE_DELAY_MS = 1_000;

/**
 * The longest wait between attempts.
 *
 * Capped deliberately low. This is a queue worker, not a batch job: whatever is
 * waiting is somebody's confirmation email, and a worker that has been retrying
 * for an hour must still resume within half a minute of the broker returning.
 */
export const RECONNECT_CEILING_MS = 30_000;

/**
 * How long to wait before reconnect attempt `attempt` (1-based).
 *
 * Plain exponential backoff to a ceiling. No jitter: there is one worker per
 * process and a handful of processes, so the thundering herd this would guard
 * against does not exist here — and a deterministic schedule is one a person
 * reading the log can predict.
 */
export function reconnectDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 1) return BASE_DELAY_MS;
  const doubled = BASE_DELAY_MS * 2 ** Math.floor(attempt - 1);
  return Math.min(doubled, RECONNECT_CEILING_MS);
}
