import { Logger } from '@nestjs/common';
import type { EmailMessage, EmailProvider } from './email.provider';
import type { MessageDeliveriesRepository } from '../messaging/message-deliveries.repository';
import { RecordingEmailProvider } from './recording-email.provider';

const NOW = new Date('2026-07-31T09:00:00.000Z');

const message = (over: Partial<EmailMessage> = {}): EmailMessage => ({
  to: 'anong@x.test',
  subject: 'You are registered',
  text: 'See you there',
  delivery: {
    organizationId: 7,
    kind: 'registration-confirmation',
    recipientName: 'Anong',
    eventId: 'e1',
  },
  ...over,
});

describe('RecordingEmailProvider (US-MSG-06)', () => {
  let inner: jest.Mocked<EmailProvider>;
  let deliveries: jest.Mocked<MessageDeliveriesRepository>;
  let provider: RecordingEmailProvider;

  beforeEach(() => {
    inner = {
      send: jest.fn().mockResolvedValue(undefined),
    };
    deliveries = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<MessageDeliveriesRepository>;
    provider = new RecordingEmailProvider(inner, deliveries, {
      now: () => NOW,
    });
  });

  it('still sends through the transport it wraps', async () => {
    const m = message();
    await provider.send(m);
    expect(inner.send).toHaveBeenCalledWith(m);
  });

  it('records what it sent, to whom, and by which channel', async () => {
    await provider.send(message());

    expect(deliveries.record).toHaveBeenCalledWith({
      organizationId: 7,
      // Named rather than left to the column default: the log now carries
      // texts as well, and a row whose channel is whatever the database
      // guessed is one an organizer cannot trust.
      channel: 'email',
      kind: 'registration-confirmation',
      recipientEmail: 'anong@x.test',
      recipientName: 'Anong',
      eventId: 'e1',
      status: 'sent',
      error: null,
      sentAt: NOW,
    });
  });

  it('records the failure AND rethrows, so the caller still dead-letters', async () => {
    // Swallowing here would turn a failed send into a silent success and stop
    // the message ever being retried.
    inner.send.mockRejectedValue(new Error('smtp 550 mailbox unavailable'));

    await expect(provider.send(message())).rejects.toThrow('smtp 550');
    expect(deliveries.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'smtp 550 mailbox unavailable',
      }),
    );
  });

  it('records nothing for a message that carries no context', async () => {
    // Password resets and verification codes are not the organizer's message
    // log, and putting them there would file somebody's account mail under a
    // workspace that has no business reading it.
    await provider.send(message({ delivery: undefined }));

    expect(inner.send).toHaveBeenCalled();
    expect(deliveries.record).not.toHaveBeenCalled();
  });

  it('does not fail a delivered message because the log write failed', async () => {
    // The email HAS gone. Throwing here would dead-letter it and send it twice.
    deliveries.record.mockRejectedValue(new Error('db down'));

    await expect(provider.send(message())).resolves.toBeUndefined();
  });

  it('still rethrows the SEND error when the log write also fails', async () => {
    // The send failure is the one that matters; the logging failure must not
    // mask it into a success.
    inner.send.mockRejectedValue(new Error('smtp 550'));
    deliveries.record.mockRejectedValue(new Error('db down'));

    await expect(provider.send(message())).rejects.toThrow('smtp 550');
  });

  /**
   * The warn line when the delivery log itself cannot be written.
   *
   * `reasonOf(cause)` was the caught error's `.message`, and the cause here comes
   * from Drizzle. Read from the installed source
   * (drizzle-orm@0.45.2/errors.cjs:36):
   *
   *     constructor(query, params, cause) {
   *       super(`Failed query: ${query}\nparams: ${params}`);
   *
   * so the message INTERPOLATES THE BOUND PARAMS — and the params of this very
   * insert are the recipient's address and name. A transient database hiccup
   * therefore printed somebody's name and email into the application log at
   * `warn`, which is emitted in production.
   *
   * The same trap was found and fixed on the API side this week
   * (`isUniqueViolation`, which read the wrapper instead of the pg error beneath
   * it). A log needs the SQLSTATE, never the statement.
   */
  describe('when the delivery log cannot be written', () => {
    const RECIPIENT = 'anong@x.test';
    const RECIPIENT_NAME = 'Anong';

    /** Shaped exactly as drizzle-orm builds it, params and all. */
    function drizzleFailure(): Error {
      const params = [
        7,
        'email',
        'registration-confirmation',
        RECIPIENT,
        RECIPIENT_NAME,
      ];
      const err = new Error(
        'Failed query: insert into "message_deliveries" ' +
          '("organization_id","channel","kind","recipient_email","recipient_name") ' +
          'values ($1,$2,$3,$4,$5)\nparams: ' +
          params.join(','),
      );
      err.cause = Object.assign(new Error('deadlock detected'), {
        code: '40P01',
        constraint: undefined,
      });
      return err;
    }

    function captureWarnings(): { text: () => string; restore: () => void } {
      const seen: unknown[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((...args: unknown[]) => {
          seen.push(...args);
        });
      return {
        text: () => JSON.stringify(seen),
        restore: () => spy.mockRestore(),
      };
    }

    it('does not print the recipient into the log', async () => {
      deliveries.record.mockRejectedValue(drizzleFailure());
      const captured = captureWarnings();
      try {
        await provider.send(message());

        expect(captured.text()).not.toContain(RECIPIENT);
        expect(captured.text()).not.toContain(RECIPIENT_NAME);
      } finally {
        captured.restore();
      }
    });

    it('does not print the statement either', async () => {
      deliveries.record.mockRejectedValue(drizzleFailure());
      const captured = captureWarnings();
      try {
        await provider.send(message());

        expect(captured.text()).not.toContain('insert into');
        expect(captured.text()).not.toContain('params:');
      } finally {
        captured.restore();
      }
    });

    /** It still has to be diagnosable: the SQLSTATE is what an operator needs. */
    it('says what the database refused, by code', async () => {
      deliveries.record.mockRejectedValue(drizzleFailure());
      const captured = captureWarnings();
      try {
        await provider.send(message());

        expect(captured.text()).toContain('40P01');
      } finally {
        captured.restore();
      }
    });

    /** And the mail itself is unaffected — a missing log row is the lesser harm. */
    it('still reports the message as sent', async () => {
      deliveries.record.mockRejectedValue(drizzleFailure());
      const captured = captureWarnings();
      try {
        await expect(provider.send(message())).resolves.toBeUndefined();
      } finally {
        captured.restore();
      }
    });
  });
});
