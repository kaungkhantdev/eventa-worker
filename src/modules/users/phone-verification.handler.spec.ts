import { Logger } from '@nestjs/common';
import {
  SmsDeliveryError,
  type SmsMessage,
  SmsProvider,
} from '../../common/sms/sms.provider';
import type { Locale } from '../../db/schema/events';
import type { MetricsService } from '../../metrics/metrics.service';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { PhoneVerificationHandler } from './phone-verification.handler';
import type { UsersRepository } from './users.repository';

const ctx: MessageContext = {
  routingKey: 'identity.phone_verification_requested',
  messageId: '77',
  correlationId: 'corr-phone',
};

const PHONE = '+66812345678';
const CODE = '042917';
const USER_ID = '6f0f8a1e-0000-4000-8000-000000000002';

/** Exactly the payload eventa-api's `phone-verification-requested.event.ts` builds. */
const rawEvent = {
  version: 1,
  organizationId: 7,
  userId: USER_ID,
  name: 'Somchai',
  phone: PHONE,
  code: CODE,
  expiresAt: '2026-10-15T07:05:00.000Z',
  occurredAt: '2026-10-15T06:55:00.000Z',
};

/** A transport that records what it was asked to text. */
class CapturingSmsProvider extends SmsProvider {
  readonly sent: SmsMessage[] = [];
  constructor(readonly enabled: boolean = true) {
    super();
  }
  send(message: SmsMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

describe('PhoneVerificationHandler (US-DISC-11 AC3)', () => {
  let sms: CapturingSmsProvider;
  let accounts: jest.Mocked<UsersRepository>;
  let locale: Locale;
  let degraded: string[];
  let handler: PhoneVerificationHandler;

  const build = () =>
    new PhoneVerificationHandler(sms, accounts, {
      recordDegradedSend: (routingKey: string) => degraded.push(routingKey),
    } as unknown as MetricsService);

  beforeEach(() => {
    sms = new CapturingSmsProvider();
    locale = 'en';
    degraded = [];
    accounts = {
      accountLocale: jest.fn(() => Promise.resolve(locale)),
    } as unknown as jest.Mocked<UsersRepository>;
    handler = build();
  });

  it('subscribes to the phone-verification routing key', () => {
    expect(handler.routingKey).toBe('identity.phone_verification_requested');
  });

  it('texts the code to the REQUESTED number', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].to).toBe(PHONE);
    expect(sms.sent[0].text).toContain(CODE);
  });

  it("writes in the member's own language", async () => {
    locale = 'th';

    await handler.handle(rawEvent, ctx);

    expect(accounts.accountLocale).toHaveBeenCalledWith(7, USER_ID);
    expect(sms.sent[0].text).toContain('รหัส');
  });

  it('files no row in the workspace delivery log', async () => {
    // A member's own account text is not the organizer's correspondence.
    await handler.handle(rawEvent, ctx);

    expect(sms.sent[0].delivery).toBeUndefined();
  });

  it('texts nothing, and completes, when the deployment has no SMS transport', async () => {
    sms = new CapturingSmsProvider(false);
    handler = build();

    await expect(handler.handle(rawEvent, ctx)).resolves.toBeUndefined();
    expect(sms.sent).toHaveLength(0);
    expect(accounts.accountLocale).not.toHaveBeenCalled();
  });

  it('texts nothing to a number that is not a Thai mobile', async () => {
    await handler.handle({ ...rawEvent, phone: '+6521234567' }, ctx);

    expect(sms.sent).toHaveLength(0);
  });

  it('still texts the code, in English, when the language cannot be read', async () => {
    // The language only refines the text; the number and the code are on
    // the message. Failing here would withhold the code for good.
    accounts.accountLocale.mockRejectedValue(
      Object.assign(new Error('down'), { code: 'ECONNREFUSED' }),
    );

    await handler.handle(rawEvent, ctx);

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].text).toContain(CODE);
    expect(degraded).toEqual(['identity.phone_verification_requested']);
  });

  it('leaves a send the transport refused to the retry ladder, with its verdict intact', async () => {
    // `failure.ts` believes `retryable`: an outage rides the ladder, a final
    // refusal parks at once. Swallowing either here would complete the
    // message, and the member would never get a code.
    for (const retryable of [true, false]) {
      const refusal = new SmsDeliveryError('provider said no', retryable);
      jest.spyOn(sms, 'send').mockRejectedValueOnce(refusal);

      await expect(handler.handle(rawEvent, ctx)).rejects.toBe(refusal);
    }
  });

  it('rejects a malformed event without texting anybody', async () => {
    await expect(
      handler.handle({ userId: USER_ID }, ctx),
    ).rejects.toBeDefined();
    expect(sms.sent).toHaveLength(0);
  });

  it('ignores unknown fields a newer producer adds', async () => {
    await handler.handle({ ...rawEvent, channel: 'sms' }, ctx);

    expect(sms.sent).toHaveLength(1);
  });

  /**
   * The code is the whole credential and the number is personal data, and
   * both travel on this message in the clear. Neither may reach a log, on any
   * path: the send, the degraded language, or the skipped send.
   */
  it('never logs the number or the code', async () => {
    const spies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );

    await handler.handle(rawEvent, ctx);
    accounts.accountLocale.mockRejectedValue(new Error('down'));
    await handler.handle(rawEvent, ctx);
    await handler.handle({ ...rawEvent, phone: '021234567' }, ctx);
    sms = new CapturingSmsProvider(false);
    await build().handle(rawEvent, ctx);

    const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
    spies.forEach((spy) => spy.mockRestore());

    expect(logged).toContain('corr-phone');
    expect(logged).not.toContain(CODE);
    expect(logged).not.toContain('812345678');
    expect(logged).not.toContain('21234567');
  });
});
