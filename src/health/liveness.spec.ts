import { DETACHED_GRACE_MS, livenessOf } from './liveness';

/**
 * When a supervisor should replace this worker.
 *
 * The old answer was "never" — `/health/live` returned ok unconditionally, so a
 * worker whose AMQP channel had died looked identical to one delivering mail.
 * It stayed that way for a day.
 *
 * The new answer has to be careful in the other direction too: restarting a
 * container is not free, and most disconnects clear themselves in seconds.
 */
describe('livenessOf', () => {
  it('is alive while consuming', () => {
    expect(livenessOf({ everConsumed: true, connected: true, downForMs: 0 })).toEqual({
      status: 'ok',
      consuming: true,
    });
  });

  /**
   * A worker mid-boot has not consumed yet and is not connected yet. Reporting
   * dead would have the supervisor kill it before it ever starts — a restart
   * loop that never converges.
   */
  it('is alive while still starting up', () => {
    expect(
      livenessOf({ everConsumed: false, connected: false, downForMs: 0 }).status,
    ).toBe('ok');
  });

  it('rides out a brief drop without asking to be restarted', () => {
    // The broker bounced; backoff is already retrying at 1s, 2s, 4s…
    expect(
      livenessOf({ everConsumed: true, connected: false, downForMs: 5_000 }).status,
    ).toBe('ok');
  });

  /**
   * Past the grace the reconnect has had several attempts and is not winning.
   * Whatever is wrong is not a blip, and a fresh process is the one remedy a
   * supervisor can apply on its own.
   */
  it('asks to be restarted once the drop outlasts the grace', () => {
    const verdict = livenessOf({
      everConsumed: true,
      connected: false,
      downForMs: DETACHED_GRACE_MS,
    });
    expect(verdict).toEqual({ status: 'error', consuming: false });
  });

  it('gives reconnection several attempts before giving up on it', () => {
    // Backoff runs 1+2+4+8+16s ≈ 31s before it reaches the 30s ceiling, so a
    // grace shorter than that would restart a worker mid-recovery.
    expect(DETACHED_GRACE_MS).toBeGreaterThanOrEqual(30_000);
  });
});
