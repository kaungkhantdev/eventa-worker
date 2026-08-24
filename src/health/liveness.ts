/**
 * How long a worker may be detached from its queue before a restart is the
 * right remedy.
 *
 * Long enough that reconnection gets a real run at it — the backoff spends
 * roughly half a minute on its first five attempts — and short enough that a
 * genuinely wedged worker is replaced before an inbox notices.
 */
export const DETACHED_GRACE_MS = 60_000;

export interface ConsumerState {
  /** Whether this process ever reached the point of consuming. */
  everConsumed: boolean;
  /** Whether a usable channel exists right now. */
  connected: boolean;
  /** How long the channel has been gone; 0 while connected. */
  downForMs: number;
}

export interface LivenessResult {
  status: 'ok' | 'error';
  consuming: boolean;
}

/**
 * Whether this worker is doing its job (US-OPS: worker liveness).
 *
 * "Live" means consuming, not merely running. A queue worker that is attached
 * to nothing is a process burning a container slot while its work piles up —
 * and the outage it causes is invisible, because every other signal about it
 * stays green.
 *
 * Two deliberate tolerances stop this from becoming a restart loop: a worker
 * that has not consumed YET is starting up, and a worker that dropped moments
 * ago is probably already reconnecting.
 */
export function livenessOf(state: ConsumerState): LivenessResult {
  const consuming = state.everConsumed && state.connected;
  if (consuming) return { status: 'ok', consuming: true };
  // Still booting — nothing to restart, and killing it here never converges.
  if (!state.everConsumed) return { status: 'ok', consuming: false };
  const recoverable = state.downForMs < DETACHED_GRACE_MS;
  return { status: recoverable ? 'ok' : 'error', consuming: false };
}
