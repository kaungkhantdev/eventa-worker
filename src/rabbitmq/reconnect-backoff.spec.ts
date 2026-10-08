import { RECONNECT_CEILING_MS, reconnectDelayMs } from './reconnect-backoff';

/**
 * How long to wait before trying the broker again.
 *
 * The shape matters in both directions. Too eager and a worker that cannot
 * reach RabbitMQ spins a reconnect loop that buries the log and hammers a
 * broker which is probably already struggling. Too patient and a blip that
 * cleared in a second costs minutes of undelivered email — which is the
 * failure this whole exercise came from.
 */
describe('reconnectDelayMs', () => {
  it('retries almost immediately the first time', () => {
    // Most drops are a blip: the broker bounced, the socket idled out. Waiting
    // a minute to discover that would be its own outage.
    expect(reconnectDelayMs(1)).toBe(1_000);
  });

  it('doubles while the broker stays away', () => {
    expect(reconnectDelayMs(2)).toBe(2_000);
    expect(reconnectDelayMs(3)).toBe(4_000);
    expect(reconnectDelayMs(4)).toBe(8_000);
  });

  /**
   * A worker that has been retrying for an hour must not have talked itself
   * into a half-hour wait: when the broker returns, email should resume within
   * the ceiling, not whenever the doubling happens to land.
   */
  it('stops doubling at the ceiling', () => {
    expect(reconnectDelayMs(10)).toBe(RECONNECT_CEILING_MS);
    expect(reconnectDelayMs(100)).toBe(RECONNECT_CEILING_MS);
    expect(RECONNECT_CEILING_MS).toBeLessThanOrEqual(30_000);
  });

  it('treats a nonsensical attempt count as the first', () => {
    // Never 0ms: that is a tight loop against a broker that is already down.
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(-3)).toBe(1_000);
    expect(reconnectDelayMs(Number.NaN)).toBe(1_000);
  });
});
