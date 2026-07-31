import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { AttendeesEmailHandler } from './attendees-email.handler';
import type {
  EventRecipientsRepository,
  Recipient,
} from './event-recipients.repository';

const ctx: MessageContext = {
  routingKey: 'events.attendees_email_requested',
  messageId: '1',
  correlationId: 'c1',
};

const rawEvent = {
  version: 1,
  organizationId: 7,
  eventId: 'e1',
  subject: 'Doors open at 9am',
  message: 'See you there — bring your QR code!',
  requestedByUserId: 'u1',
  recipientCount: 2,
  occurredAt: '2026-07-31T00:00:00.000Z',
};

describe('AttendeesEmailHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let recipients: jest.Mocked<EventRecipientsRepository>;
  let handler: AttendeesEmailHandler;

  beforeEach(() => {
    sent = [];
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    recipients = {
      confirmedRecipients: jest.fn(),
    } as unknown as jest.Mocked<EventRecipientsRepository>;
    handler = new AttendeesEmailHandler(recipients, email);
  });

  it('subscribes to the broadcast routing key', () => {
    expect(handler.routingKey).toBe('events.attendees_email_requested');
  });

  it('resolves confirmed attendees at send time and mails each individually', async () => {
    recipients.confirmedRecipients.mockResolvedValue([
      { email: 'anan@x.test', name: 'Anan' },
      { email: 'ben@x.test', name: 'Ben' },
    ] satisfies Recipient[]);

    await handler.handle(rawEvent, ctx);

    expect(recipients.confirmedRecipients).toHaveBeenCalledWith(7, 'e1');
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(sent.map((m) => m.to)).toEqual(['anan@x.test', 'ben@x.test']);
    expect(sent[0].subject).toBe('Doors open at 9am');
    expect(sent[0].text).toContain('bring your QR code');
  });

  it('sends nothing when the event has no confirmed attendees', async () => {
    recipients.confirmedRecipients.mockResolvedValue([]);
    await handler.handle(rawEvent, ctx);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('keeps mailing the rest when one recipient fails, then dead-letters (throws)', async () => {
    recipients.confirmedRecipients.mockResolvedValue([
      { email: 'ok1@x.test', name: 'A' },
      { email: 'bad@x.test', name: 'B' },
      { email: 'ok2@x.test', name: 'C' },
    ] satisfies Recipient[]);
    (email.send as jest.Mock).mockImplementation((m: EmailMessage) => {
      if (m.to === 'bad@x.test') return Promise.reject(new Error('smtp 550'));
      sent.push(m);
      return Promise.resolve();
    });

    // a partial failure dead-letters the message (so the failure is visible)…
    await expect(handler.handle(rawEvent, ctx)).rejects.toBeDefined();
    // …but the bad address did NOT abort the batch — the rest were still tried.
    expect(email.send).toHaveBeenCalledTimes(3);
    expect(sent.map((m) => m.to)).toEqual(['ok1@x.test', 'ok2@x.test']);
  });

  it('rejects a malformed event (missing subject/message)', async () => {
    await expect(
      handler.handle({ organizationId: 7, eventId: 'e1' }, ctx),
    ).rejects.toBeDefined();
    expect(email.send).not.toHaveBeenCalled();
  });
});
