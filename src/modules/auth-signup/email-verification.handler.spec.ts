import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { EmailVerificationHandler } from './email-verification.handler';

const ctx: MessageContext = {
  routingKey: 'identity.email_verification_requested',
  messageId: '42',
  correlationId: 'corr-1',
};

const rawEvent = {
  version: 1,
  organizationId: 7,
  userId: 'u1',
  name: 'Somchai',
  email: 'owner@acme.co.th',
  verifyUrl: 'https://web.test/verify-email?token=VTOKEN',
  occurredAt: '2026-07-31T00:00:00.000Z',
};

describe('EmailVerificationHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let handler: EmailVerificationHandler;

  beforeEach(() => {
    sent = [];
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    handler = new EmailVerificationHandler(email);
  });

  it('subscribes to the verification routing key', () => {
    expect(handler.routingKey).toBe('identity.email_verification_requested');
  });

  it('sends a confirmation email carrying the verify link to the registrant', async () => {
    await handler.handle(rawEvent, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
    const message = sent[0];
    expect(message.to).toBe('owner@acme.co.th');
    expect(message.subject).toMatch(/confirm your email/i);
    expect(message.text).toContain(
      'https://web.test/verify-email?token=VTOKEN',
    );
    expect(message.text).toContain('Somchai');
  });

  it('rejects a malformed event (tolerant reader still requires the core fields)', async () => {
    await expect(handler.handle({ userId: 'u1' }, ctx)).rejects.toBeDefined();
    expect(email.send).not.toHaveBeenCalled();
  });
});
