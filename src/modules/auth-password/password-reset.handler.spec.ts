import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { PasswordResetHandler } from './password-reset.handler';

const ctx: MessageContext = {
  routingKey: 'identity.password_reset_requested',
  messageId: '7',
  correlationId: 'corr-2',
};

const rawEvent = {
  version: 1,
  organizationId: 7,
  userId: 'u1',
  name: 'Somchai',
  email: 'owner@acme.co.th',
  resetUrl: 'https://web.test/reset-password?token=RTOKEN',
  occurredAt: '2026-07-31T00:00:00.000Z',
};

describe('PasswordResetHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let handler: PasswordResetHandler;

  beforeEach(() => {
    sent = [];
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    handler = new PasswordResetHandler(email);
  });

  it('subscribes to the password-reset routing key', () => {
    expect(handler.routingKey).toBe('identity.password_reset_requested');
  });

  it('sends a reset email carrying the single-use link to the account holder', async () => {
    await handler.handle(rawEvent, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe('owner@acme.co.th');
    expect(sent[0].subject).toMatch(/reset your/i);
    expect(sent[0].text).toContain(
      'https://web.test/reset-password?token=RTOKEN',
    );
  });

  /**
   * One address can hold an organizer account in several workspaces and gets
   * one email per account, so each has to say which workspace its link opens.
   */
  it('names the workspace the link opens, when the event carries one', async () => {
    await handler.handle({ ...rawEvent, workspaceName: 'Acme Events' }, ctx);

    expect(sent[0].text).toContain('“Acme Events”');
  });

  it('names no workspace when the event carries none', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].text).not.toMatch(/workspace/i);
  });

  it('rejects a malformed event', async () => {
    await expect(handler.handle({ userId: 'u1' }, ctx)).rejects.toBeDefined();
    expect(email.send).not.toHaveBeenCalled();
  });

  /**
   * The name on the account, which is free text whoever holds a session can
   * set — the same wire field, and the same threat model, as the notices that
   * stopped greeting by name. A reset mail says "if you didn't ask for this you
   * can ignore this email", which is exactly the claim a lure wants to borrow.
   */
  describe('a name that is not one', () => {
    const LINE_BREAK = String.fromCodePoint(0x0a);

    it('adds no line to the body', async () => {
      const lure =
        'Somchai' + LINE_BREAK + 'Ignore the link below and call 0812345678';

      await handler.handle({ ...rawEvent, name: lure }, ctx);

      expect(sent[0].text.split(LINE_BREAK)[0]).toBe('Hi,');
      expect(sent[0].text).not.toContain('0812345678');
    });

    it('still greets a real name', async () => {
      await handler.handle({ ...rawEvent, name: 'Somchai Jaidee' }, ctx);
      expect(sent[0].text.split(LINE_BREAK)[0]).toBe('Hi Somchai Jaidee,');
    });
  });
});
