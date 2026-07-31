import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { EventCancelledHandler } from './event-cancelled.handler';
import type {
  EventRecipientsRepository,
  Recipient,
} from './event-recipients.repository';

const ctx: MessageContext = {
  routingKey: 'events.cancelled',
  messageId: '1',
  correlationId: 'c1',
};

const rawEvent = {
  version: 1,
  organizationId: 7,
  eventId: 'e1',
  slug: 'bangkok-summit-2026',
  name: 'Bangkok Summit 2026',
  reason: 'Venue flooded',
  cancelledBy: 'u1',
  occurredAt: '2026-07-31T00:00:00.000Z',
};

describe('EventCancelledHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let recipients: jest.Mocked<EventRecipientsRepository>;
  let handler: EventCancelledHandler;

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
    handler = new EventCancelledHandler(recipients, email);
  });

  it('subscribes to the events.cancelled routing key', () => {
    expect(handler.routingKey).toBe('events.cancelled');
  });

  it('notifies every confirmed attendee that the event is cancelled', async () => {
    recipients.confirmedRecipients.mockResolvedValue([
      { email: 'anan@x.test', name: 'Anan' },
    ] satisfies Recipient[]);

    await handler.handle(rawEvent, ctx);

    expect(recipients.confirmedRecipients).toHaveBeenCalledWith(7, 'e1');
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe('anan@x.test');
    expect(sent[0].subject).toMatch(/cancelled/i);
    expect(sent[0].text).toContain('Bangkok Summit 2026');
    expect(sent[0].text).toContain('Venue flooded');
  });

  it('keeps notifying the rest when one recipient fails, then dead-letters (throws)', async () => {
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

    await expect(handler.handle(rawEvent, ctx)).rejects.toBeDefined();
    expect(email.send).toHaveBeenCalledTimes(3);
    expect(sent.map((m) => m.to)).toEqual(['ok1@x.test', 'ok2@x.test']);
  });

  it('rejects a malformed event', async () => {
    await expect(
      handler.handle({ organizationId: 7 }, ctx),
    ).rejects.toBeDefined();
    expect(email.send).not.toHaveBeenCalled();
  });
});
