import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { EventRecipientsRepository } from '../events/event-recipients.repository';
import { RegistrationRejectedHandler } from './registration-rejected.handler';
import type {
  RegistrationRepository,
  RejectionSource,
} from './registration.repository';

const ctx: MessageContext = {
  routingKey: 'registration.rejected',
  messageId: 'm-1',
  correlationId: 'c-1',
};

/** The organizer's own words, which the attendee must never be shown. */
const ORGANIZER_NOTE = 'Suspected duplicate — same card as ORD-9999';

const PAYLOAD = {
  version: 1,
  organizationId: 7,
  orderId: 'o-1',
  reference: 'ORD-AAAA1111',
  eventId: 'e-1',
  buyerEmail: 'anan@example.test',
  buyerName: 'Anan',
  reason: ORGANIZER_NOTE,
  occurredAt: '2026-08-01T03:00:00.000Z',
};

const UNPAID: RejectionSource = {
  eventName: 'Bangkok Tech Week',
  totalSatang: 210_000,
  currency: 'THB',
  paymentStatus: 'pending',
};

const NO_WORDING = {
  subjectEn: null,
  bodyEn: null,
  subjectTh: null,
  bodyTh: null,
};

describe('RegistrationRejectedHandler (US-REG-02)', () => {
  let sent: EmailMessage[];
  let repo: jest.Mocked<RegistrationRepository>;
  let templates: jest.Mocked<MessageTemplatesRepository>;
  let recipients: jest.Mocked<EventRecipientsRepository>;
  let idempotency: jest.Mocked<IdempotencyService>;
  let handler: RegistrationRejectedHandler;

  beforeEach(() => {
    sent = [];
    const email: EmailProvider = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    repo = {
      loadRejection: jest.fn().mockResolvedValue(UNPAID),
    } as unknown as jest.Mocked<RegistrationRepository>;
    templates = {
      isActive: jest.fn().mockResolvedValue(true),
      wordingFor: jest.fn().mockResolvedValue(NO_WORDING),
    } as unknown as jest.Mocked<MessageTemplatesRepository>;
    recipients = {
      attendeeLocales: jest.fn().mockResolvedValue(new Map()),
      fallbackLocale: jest.fn().mockResolvedValue('en'),
    } as unknown as jest.Mocked<EventRecipientsRepository>;
    idempotency = {
      isCompleted: jest.fn().mockResolvedValue(false),
      markCompleted: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IdempotencyService>;
    handler = new RegistrationRejectedHandler(
      email,
      repo,
      templates,
      recipients,
      idempotency,
    );
  });

  /**
   * The whole defect: this key reached the exchange with nothing bound to it,
   * so an attendee turned down was never told and nothing anywhere recorded it.
   */
  it('binds to the routing key eventa-api publishes', () => {
    expect(handler.routingKey).toBe('registration.rejected');
  });

  it('emails the attendee that their place was not confirmed', async () => {
    await handler.handle(PAYLOAD, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'anan@example.test',
      subject: 'Your registration for Bangkok Tech Week was not approved',
      delivery: {
        organizationId: 7,
        kind: 'rejection-notice',
        recipientName: 'Anan',
        eventId: 'e-1',
      },
    });
    expect(sent[0].text).toContain('ORD-AAAA1111');
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m-1');
  });

  /**
   * `reason` is the organizer's own note, kept for their audit trail — the
   * producer's event says it is "shown to nobody but the organizer". A note
   * reading "suspected duplicate" or "blacklisted" is not a sentence to
   * forward to the person it is about.
   */
  it('never repeats the organizer’s note back to the attendee', async () => {
    await handler.handle(PAYLOAD, ctx);
    expect(sent[0].text).not.toContain('duplicate');
    expect(sent[0].text).not.toContain('ORD-9999');
    expect(sent[0].subject).not.toContain('duplicate');
  });

  /**
   * And so a rejection with no explanation reads identically to one with a
   * note. There is no hole where a reason would have gone.
   */
  it('sends the same civil message when the organizer gave no reason', async () => {
    await handler.handle({ ...PAYLOAD, reason: null }, ctx);
    await handler.handle(PAYLOAD, { ...ctx, messageId: 'm-2' });
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toBe(sent[1].text);
    expect(sent[0].text).toContain('contact the organizer');
  });

  it('sends nothing when the organizer switched the notice off', async () => {
    templates.isActive.mockResolvedValue(false);
    await handler.handle(PAYLOAD, ctx);
    expect(templates.isActive).toHaveBeenCalledWith(7, 'rejection-notice');
    expect(sent).toHaveLength(0);
    // Asked before the order is read: a message that will not be sent is no
    // reason to pull somebody's name and money out of the database.
    expect(repo.loadRejection).not.toHaveBeenCalled();
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m-1');
  });

  it('tells a buyer refunded by the rejection that their money went back', async () => {
    repo.loadRejection.mockResolvedValue({
      ...UNPAID,
      paymentStatus: 'refunded',
    });
    await handler.handle(PAYLOAD, ctx);
    expect(sent[0].text).toContain('฿2,100.00 has been refunded');
  });

  /**
   * The rejection commits before eventa-api attempts the refund, so the money
   * is still captured when this message is usually read. "Rejected" and
   * "refunded" are different facts and the attendee is owed both.
   */
  it('promises the refund that is still owed on a paid registration', async () => {
    repo.loadRejection.mockResolvedValue({ ...UNPAID, paymentStatus: 'paid' });
    await handler.handle(PAYLOAD, ctx);
    expect(sent[0].text).toContain('฿2,100.00 will be refunded');
  });

  it('writes in the attendee’s own language', async () => {
    recipients.attendeeLocales.mockResolvedValue(
      new Map([['anan@example.test', 'th']]),
    );
    await handler.handle(PAYLOAD, ctx);
    expect(sent[0].text).toContain('สวัสดีคุณ Anan');
  });

  it('fills the organizer’s merge fields into their opening', async () => {
    templates.wordingFor.mockResolvedValue({
      ...NO_WORDING,
      bodyEn: 'Hi {{first_name}} — we could not confirm {{event_name}}.',
    });
    await handler.handle(PAYLOAD, ctx);
    expect(
      sent[0].text.startsWith(
        'Hi Anan — we could not confirm Bangkok Tech Week.',
      ),
    ).toBe(true);
    expect(sent[0].text).toContain('ORD-AAAA1111');
  });

  it('sends nothing for an order that is no longer there', async () => {
    repo.loadRejection.mockResolvedValue(null);
    await handler.handle(PAYLOAD, ctx);
    expect(sent).toHaveLength(0);
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m-1');
  });

  it('does not send twice when the message is redelivered', async () => {
    idempotency.isCompleted.mockResolvedValue(true);
    await handler.handle(PAYLOAD, ctx);
    expect(sent).toHaveLength(0);
  });

  /** Tolerant reader: a producer that adds a field must not dead-letter. */
  it('accepts a payload carrying a field it does not know', async () => {
    await handler.handle({ ...PAYLOAD, decidedBy: 'u-9' }, ctx);
    expect(sent).toHaveLength(1);
  });
});
