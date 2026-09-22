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
});
