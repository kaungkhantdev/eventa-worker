import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type {
  IdempotencyService,
  SentLedger,
} from '../../common/idempotency/idempotency.service';
import type { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
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

/** Idempotency stub backing recipientLedger() with a shared in-memory Set. */
function stubIdempotency(seed: string[] = []): {
  idempotency: IdempotencyService;
  ledgerStore: Set<string>;
} {
  const ledgerStore = new Set<string>(seed);
  const ledger: SentLedger = {
    wasSent: (key) => Promise.resolve(ledgerStore.has(key)),
    markSent: (key) => {
      ledgerStore.add(key);
      return Promise.resolve();
    },
  };
  const idempotency = {
    recipientLedger: jest.fn(() => ledger),
  } as unknown as IdempotencyService;
  return { idempotency, ledgerStore };
}

describe('EventCancelledHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let recipients: jest.Mocked<EventRecipientsRepository>;
  let templates: jest.Mocked<MessageTemplatesRepository>;
  let idempotency: IdempotencyService;
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
    templates = {
      isActive: jest.fn().mockResolvedValue(true),
      // No row stored: Eventa's own copy is what goes out.
      wordingFor: jest.fn().mockResolvedValue({
        subjectEn: null,
        bodyEn: null,
        subjectTh: null,
        bodyTh: null,
      }),
    } as unknown as jest.Mocked<MessageTemplatesRepository>;
    idempotency = stubIdempotency().idempotency;
    handler = new EventCancelledHandler(
      recipients,
      templates,
      email,
      idempotency,
    );
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

  describe('the organizer’s kill switch (US-MSG-01)', () => {
    it('asks whether the cancellation notice is switched on', async () => {
      recipients.confirmedRecipients.mockResolvedValue([
        { email: 'anan@x.test', name: 'Anan' },
      ] satisfies Recipient[]);

      await handler.handle(rawEvent, ctx);

      expect(templates.isActive).toHaveBeenCalledWith(7, 'cancellation-notice');
    });

    it('sends nothing when the organizer has switched it off', async () => {
      templates.isActive.mockResolvedValue(false);
      recipients.confirmedRecipients.mockResolvedValue([
        { email: 'anan@x.test', name: 'Anan' },
      ] satisfies Recipient[]);

      await handler.handle(rawEvent, ctx);

      expect(email.send).not.toHaveBeenCalled();
    });

    it('does not even read the attendee list when it is switched off', async () => {
      // Recipients are people's names and addresses. A message that will not be
      // sent is no reason to pull them out of the database.
      templates.isActive.mockResolvedValue(false);

      await handler.handle(rawEvent, ctx);

      expect(recipients.confirmedRecipients).not.toHaveBeenCalled();
    });
  });

  it('tags each message for the delivery log (US-MSG-06)', async () => {
    // Without this the send happens and nothing can say afterwards that it
    // did — the whole point of the log is the messages that are IN it.
    recipients.confirmedRecipients.mockResolvedValue([
      { email: 'anan@x.test', name: 'Anan' },
    ] satisfies Recipient[]);

    await handler.handle(rawEvent, ctx);

    expect(sent[0].delivery).toEqual({
      organizationId: 7,
      kind: 'cancellation-notice',
      recipientName: 'Anan',
      eventId: 'e1',
    });
  });

  describe('the organizer’s own wording (US-MSG-02)', () => {
    beforeEach(() =>
      recipients.confirmedRecipients.mockResolvedValue([
        { email: 'anan@x.test', name: 'Anan' },
      ] satisfies Recipient[]),
    );

    it('sends what the organizer wrote, with the fields filled', async () => {
      templates.wordingFor.mockResolvedValue({
        subjectEn: '{{event_name}} is off',
        bodyEn: 'Sorry {{first_name}} — {{reason}}.',
        subjectTh: null,
        bodyTh: null,
      });

      await handler.handle(rawEvent, ctx);

      expect(sent[0].subject).toBe('Bangkok Summit 2026 is off');
      expect(sent[0].text).toContain('Sorry Anan — Venue flooded.');
    });

    it('keeps the refund line whatever the organizer wrote', async () => {
      // Somebody whose event was cancelled needs to know their money is
      // coming back. That is not a sentence to leave to whoever was editing a
      // template at the time.
      templates.wordingFor.mockResolvedValue({
        subjectEn: null,
        bodyEn: 'Cancelled.',
        subjectTh: null,
        bodyTh: null,
      });

      await handler.handle(rawEvent, ctx);

      expect(sent[0].text).toContain('refund');
    });
  });

  it('does not re-notify a recipient already recorded as sent (idempotent re-entry)', async () => {
    const seeded = stubIdempotency(['anan@x.test']);
    handler = new EventCancelledHandler(
      recipients,
      templates,
      email,
      seeded.idempotency,
    );
    recipients.confirmedRecipients.mockResolvedValue([
      { email: 'anan@x.test', name: 'Anan' },
      { email: 'ben@x.test', name: 'Ben' },
    ] satisfies Recipient[]);

    await handler.handle(rawEvent, ctx);

    expect(sent.map((m) => m.to)).toEqual(['ben@x.test']);
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
