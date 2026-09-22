import { ZodError } from 'zod';
import { isRetryable } from './failure';

/** A nodemailer-shaped rejection. */
function smtp(fields: { code?: string; responseCode?: number }): Error {
  return Object.assign(new Error('smtp said no'), fields);
}

/** A node-postgres rejection, whose `code` is the SQLSTATE. */
function pg(code: string): Error {
  return Object.assign(new Error('postgres said no'), { code });
}

describe('isRetryable', () => {
  /**
   * Poison: no amount of waiting makes these succeed, so they go straight to
   * the dead-letter queue rather than burning four attempts first.
   */
  describe('permanent', () => {
    it('refuses to retry a payload that does not match its schema', () => {
      expect(isRetryable(new ZodError([]))).toBe(false);
    });

    it('refuses to retry a body that is not JSON', () => {
      expect(isRetryable(new SyntaxError('Unexpected token < in JSON'))).toBe(
        false,
      );
    });

    // 5xx is SMTP's own "permanent failure" class — a mailbox that does not
    // exist will not exist in ten minutes either.
    it('refuses to retry a permanent SMTP rejection', () => {
      expect(isRetryable(smtp({ responseCode: 550 }))).toBe(false);
      expect(isRetryable(smtp({ responseCode: 553 }))).toBe(false);
    });

    it('refuses to retry an unusable recipient address', () => {
      expect(isRetryable(smtp({ code: 'EENVELOPE' }))).toBe(false);
    });

    /**
     * An SMS transport speaks HTTP, where 5xx is TRANSIENT — the opposite of
     * SMTP. Rather than teach this function a second, contradictory reading of
     * a status code, `SmsDeliveryError` states the answer outright.
     */
    it('takes a transport at its word when it says not to retry', () => {
      expect(
        isRetryable(Object.assign(new Error('HTTP 400'), { retryable: false })),
      ).toBe(false);
    });

    it('still retries when a transport says it is worth it', () => {
      expect(
        isRetryable(Object.assign(new Error('HTTP 503'), { retryable: true })),
      ).toBe(true);
    });
  });

  /**
   * Transient: the world is briefly broken, and the message is fine. These are
   * the ones the old code destroyed on the first attempt.
   */
  describe('transient', () => {
    it('retries a connection that failed or timed out', () => {
      for (const code of ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET'])
        expect(isRetryable(smtp({ code }))).toBe(true);
    });

    // 4xx is SMTP's "try again later" — greylisting and rate limits live here.
    it('retries a temporary SMTP rejection', () => {
      expect(isRetryable(smtp({ responseCode: 421 }))).toBe(true);
      expect(isRetryable(smtp({ responseCode: 451 }))).toBe(true);
    });

    /**
     * Bad credentials are transient in the only sense that matters: somebody
     * fixes the secret and it works. Retrying costs four attempts and then it
     * parks — which is a far better outcome than losing a signup's only
     * verification email to a rotated app password.
     */
    it('retries a rejected login, then lets the ladder park it', () => {
      expect(isRetryable(smtp({ code: 'EAUTH', responseCode: 535 }))).toBe(
        true,
      );
    });

    it('retries a serialization failure or a deadlock', () => {
      expect(isRetryable(pg('40001'))).toBe(true);
      expect(isRetryable(pg('40P01'))).toBe(true);
    });

    it('retries a database that refused or dropped the connection', () => {
      expect(isRetryable(pg('08006'))).toBe(true);
      expect(isRetryable(pg('53300'))).toBe(true);
    });
  });

  /**
   * The default is to retry. Being wrong about a poison message costs four
   * attempts and it parks anyway; being wrong about a transient one loses
   * somebody's email outright, which is the failure this whole ladder exists
   * to stop.
   */
  describe('unrecognised', () => {
    it('retries an error it has never seen', () => {
      expect(isRetryable(new Error('something new'))).toBe(true);
      expect(isRetryable('a thrown string')).toBe(true);
      expect(isRetryable(undefined)).toBe(true);
    });
  });
});
