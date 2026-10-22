import { Logger } from '@nestjs/common';
import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import { isRetryable } from '../../rabbitmq/failure';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { BookingAccountLinkHandler } from './booking-account-link.handler';

const ctx: MessageContext = {
  routingKey: 'identity.booking_account_link_requested',
  messageId: '9001',
  correlationId: 'corr-claim',
};

const ORDER_ID = '0b6f5c1e-0000-4000-8000-0000000000aa';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.CLAIM.SIGNATURE';
const CLAIM_URL = `https://web.test/portal/register?claim=${TOKEN}`;
const BUYER = 'malee@example.com';

/** Exactly the payload eventa-api writes for `identity.booking_account_link_requested`. */
const rawEvent = {
  version: 1,
  organizationId: 1,
  orderId: ORDER_ID,
  name: 'Malee',
  email: BUYER,
  eventName: 'Bangkok Jazz Night',
  claimUrl: CLAIM_URL,
  expiresAt: '2026-10-22T07:05:00.000Z',
  locale: 'en',
  occurredAt: '2026-10-15T07:05:00.000Z',
};

/** The event without one field, for the tolerance and rejection cases. */
function without(field: keyof typeof rawEvent): Record<string, unknown> {
  const event: Record<string, unknown> = { ...rawEvent };
  delete event[field];
  return event;
}

describe('BookingAccountLinkHandler (US-DISC-15)', () => {
  let sent: EmailMessage[];
  let email: jest.Mocked<EmailProvider>;
  let handler: BookingAccountLinkHandler;

  beforeEach(() => {
    sent = [];
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    handler = new BookingAccountLinkHandler(email);
  });

  afterEach(() => jest.restoreAllMocks());

  it('subscribes to the booking-account-link routing key', () => {
    expect(handler.routingKey).toBe('identity.booking_account_link_requested');
  });

  it('mails the claim link, and when it expires, to the booking’s address', async () => {
    await handler.handle(rawEvent, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe(BUYER);
    expect(sent[0].subject).toBe(
      'Keep your tickets for Bangkok Jazz Night in an Eventa account',
    );
    expect(sent[0].text).toContain(CLAIM_URL);
    expect(sent[0].text).toContain('22 October 2026 at 14:05');
  });

  it('writes in Thai for a Thai booking', async () => {
    await handler.handle({ ...rawEvent, locale: 'th' }, ctx);

    expect(sent[0].subject).toContain('บัญชี Eventa');
    expect(sent[0].text).toContain('ตั้งรหัสผ่าน');
    expect(sent[0].text).toContain(CLAIM_URL);
  });

  it('files no row in any workspace’s delivery log', async () => {
    // A person's own account mail is not an organizer's correspondence.
    await handler.handle(rawEvent, ctx);

    expect(sent[0].delivery).toBeUndefined();
  });

  describe('tolerant reader', () => {
    it('ignores fields a newer producer adds', async () => {
      await handler.handle({ ...rawEvent, reference: 'EVT-1234' }, ctx);

      expect(sent).toHaveLength(1);
    });

    it('reads a payload with no version as version 1', async () => {
      await handler.handle(without('version'), ctx);

      expect(sent).toHaveLength(1);
    });

    it('writes in English when the payload names no language', async () => {
      await handler.handle(without('locale'), ctx);

      expect(sent[0].subject).toMatch(/^Keep your tickets/);
    });

    it('writes in English, rather than dead-lettering the link, for a language it does not know', async () => {
      await handler.handle({ ...rawEvent, locale: 'fr' }, ctx);

      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toMatch(/^Keep your tickets/);
    });

    it.each([
      'organizationId',
      'orderId',
      'name',
      'email',
      'eventName',
      'claimUrl',
      'expiresAt',
      'occurredAt',
    ] as const)(
      'refuses a payload with no %s, as poison, and mails nobody',
      async (field) => {
        const failure = await handler
          .handle(without(field), ctx)
          .catch((e: unknown) => e);

        expect(failure).toBeInstanceOf(Error);
        // Poison parks at once: it will fail identically every time.
        expect(isRetryable(failure)).toBe(false);
        expect(email.send).not.toHaveBeenCalled();
      },
    );

    /**
     * The consumer logs a refused payload's error (through `safeError`, which
     * masks addresses but not URLs). So the error itself must not carry the
     * link — or the address — from a payload that was otherwise fine.
     */
    it('refuses a bad payload with an error that holds neither the link nor the address', async () => {
      const failure = await handler
        .handle({ ...rawEvent, organizationId: 'one' }, ctx)
        .catch((e: unknown) => e);

      const text = `${(failure as Error).message} ${(failure as Error).stack}`;
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(BUYER);
    });
  });

  describe('delivery failure', () => {
    /**
     * Idempotency and retry are `ConsumerService`'s: it marks the message id
     * completed only after this returns, so a failed send must THROW — that is
     * what rides the retry ladder. Swallowing it would complete the message,
     * and the only link that can create this account would never arrive.
     */
    it('rethrows a failed send so the message is retried, not completed', async () => {
      const outage = Object.assign(new Error('greylisted'), {
        responseCode: 451,
      });
      email.send.mockRejectedValueOnce(outage);

      await expect(handler.handle(rawEvent, ctx)).rejects.toBe(outage);
      expect(isRetryable(outage)).toBe(true);
    });

    it('sends again on a redelivery after a failed attempt', async () => {
      email.send.mockRejectedValueOnce(new Error('connection reset'));

      await handler.handle(rawEvent, ctx).catch(() => undefined);
      await handler.handle(rawEvent, ctx);

      expect(sent).toHaveLength(1);
      expect(email.send).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * The token in the link IS the proof that this inbox owns the address: with
   * it, anybody can create the account and choose its password. The address is
   * personal data. Neither may reach a log on any path — sent, failed, or
   * refused.
   */
  it('never logs the link, its token or the address', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );

    await handler.handle(rawEvent, ctx);
    await handler.handle({ ...rawEvent, locale: 'th' }, ctx);
    email.send.mockRejectedValueOnce(new Error(`550 ${BUYER} unknown`));
    await handler.handle(rawEvent, ctx).catch(() => undefined);
    await handler.handle(without('claimUrl'), ctx).catch(() => undefined);

    const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));

    expect(logged).toContain('corr-claim');
    expect(logged).toContain(ORDER_ID);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('claim=');
    expect(logged).not.toContain(BUYER);
  });
});
