import { Logger } from '@nestjs/common';
import type { EmailMessage } from './email.provider';
import { LogEmailProvider } from './log-email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';

const sendMail = jest.fn<Promise<{ messageId: string }>, [unknown]>();
jest.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: (options: unknown) => sendMail(options),
    close: jest.fn(),
  }),
}));

/**
 * The subject is no longer Eventa's own copy.
 *
 * `fill()` substitutes an organizer's merge fields, and its docstring records
 * that the SAME filled string becomes the subject: a template of
 * `Hi {{first_name}}, your ticket` puts a buyer's real name in the subject
 * line. Both providers used to log it at `log` level — the SMTP one under the
 * comment "The subject is safe to log" — while being careful to keep the
 * recipient at `debug` and never to log the body at all.
 *
 * One spec over both providers rather than one each: the rule is about the
 * value, not the transport, and there is a third provider promised (SES). A
 * per-provider test is a rule the next provider can be written without.
 */
const BUYER = 'Somchai Jaidee';

function message(over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: 'somchai@example.test',
    subject: `Hi ${BUYER}, your ticket for Bangkok Tech Week`,
    text: 'Your ticket is attached.',
    delivery: {
      organizationId: 1,
      kind: 'ticket-confirmation',
      recipientName: BUYER,
      eventId: 'evt_1',
    },
    ...over,
  };
}

/** Every argument handed to any level of the logger, flattened to text. */
function captureLogs(): { lines: () => string; restore: () => void } {
  const seen: unknown[] = [];
  const levels = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
  const spies = levels.map((level) =>
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((...args: unknown[]) => {
        seen.push(...args);
      }),
  );
  return {
    lines: () => JSON.stringify(seen),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

const smtpConfig = {
  get: (key: string) => {
    if (key === 'EMAIL_FROM') return 'Eventa <no-reply@eventa.test>';
    if (key === 'SMTP_PORT') return 1025;
    if (key === 'SMTP_SECURE') return false;
    return undefined;
  },
  getOrThrow: () => 'localhost',
} as never;

describe('what a provider may write to the log', () => {
  const providers: [
    string,
    () => { send: (m: EmailMessage) => Promise<void> },
  ][] = [
    ['LogEmailProvider', () => new LogEmailProvider()],
    ['SmtpEmailProvider', () => new SmtpEmailProvider(smtpConfig)],
  ];

  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ messageId: '<abc@eventa.test>' });
  });

  it.each(providers)('%s never logs the subject', async (_name, build) => {
    const captured = captureLogs();
    try {
      await build().send(message());
      expect(captured.lines()).not.toContain('your ticket for');
    } finally {
      captured.restore();
    }
  });

  it.each(providers)(
    '%s never logs a name from the subject',
    async (_name, build) => {
      const captured = captureLogs();
      try {
        await build().send(message());
        expect(captured.lines()).not.toContain(BUYER);
      } finally {
        captured.restore();
      }
    },
  );

  /**
   * `DeliveryContext.recipientName` sits on the same object, so logging the
   * delivery context wholesale would reintroduce the leak by another door.
   */
  it.each(providers)(
    '%s never logs the delivery context wholesale',
    async (_name, build) => {
      const captured = captureLogs();
      try {
        await build().send(message());
        expect(captured.lines()).not.toContain('recipientName');
      } finally {
        captured.restore();
      }
    },
  );

  /**
   * The line still has to earn its place. `kind` is the catalog slug — which
   * KIND of mail went out, with no personal data in it — and is a better
   * debugging handle than per-organizer prose ever was.
   */
  it.each(providers)(
    '%s still says which kind of mail went out',
    async (_name, build) => {
      const captured = captureLogs();
      try {
        await build().send(message());
        expect(captured.lines()).toContain('ticket-confirmation');
      } finally {
        captured.restore();
      }
    },
  );

  /** Account mail (password reset, verification) carries no delivery context. */
  it.each(providers)(
    '%s logs account mail without inventing a kind',
    async (_name, build) => {
      const captured = captureLogs();
      try {
        await build().send(message({ delivery: undefined }));
        expect(captured.lines()).not.toContain(BUYER);
        expect(captured.lines()).not.toContain('undefined');
      } finally {
        captured.restore();
      }
    },
  );
});
