import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { EventRecipientsRepository } from '../events/event-recipients.repository';
import { WaitlistOfferedHandler } from './waitlist-offered.handler';
import type {
  WaitlistContext,
  WaitlistRepository,
} from './waitlist.repository';

const NOW = new Date('2026-08-01T03:00:00.000Z');
const UNTIL = '2026-08-02T03:00:00.000Z';
const ctx: MessageContext = {
  routingKey: 'waitlist.offered',
  messageId: 'm-1',
  correlationId: 'c-1',
};
const PAYLOAD = {
  version: 1,
  organizationId: 7,
  orderId: 'o-1',
  reference: 'ORD-AAAA1111',
  eventId: 'e-1',
  buyerEmail: 'anan@example.test',
  buyerName: 'Anan',
  ticketTypeName: 'General',
  ticketCount: 2,
  totalSatang: 210_000,
  currency: 'THB',
  offerExpiresAt: UNTIL,
  payUrl: 'https://web.test/my/tickets/orders/o-1',
  occurredAt: NOW.toISOString(),
};
const OPEN: WaitlistContext = {
  eventName: 'Bangkok Tech Week',
  timezone: 'Asia/Bangkok',
  status: 'pending',
  paymentStatus: 'pending',
  offerExpiresAt: new Date(UNTIL),
};
const NO_WORDING = {
  subjectEn: null,
  bodyEn: null,
  subjectTh: null,
  bodyTh: null,
};

describe('WaitlistOfferedHandler (US-REG-04)', () => {
  let sent: EmailMessage[];
  let repo: jest.Mocked<WaitlistRepository>;
  let templates: jest.Mocked<MessageTemplatesRepository>;
  let recipients: jest.Mocked<EventRecipientsRepository>;
  let idempotency: jest.Mocked<IdempotencyService>;
  let handler: WaitlistOfferedHandler;

  beforeEach(() => {
    sent = [];
    const email: EmailProvider = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    repo = {
      context: jest.fn().mockResolvedValue(OPEN),
    } as unknown as jest.Mocked<WaitlistRepository>;
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
    handler = new WaitlistOfferedHandler(
      email,
      repo,
      templates,
      recipients,
      idempotency,
      { now: () => NOW },
    );
  });

  it('binds to the routing key both the API and the sweep publish', () => {
    expect(handler.routingKey).toBe('waitlist.offered');
  });

  it('emails the offer — seats, price, deadline and the page to pay on', async () => {
    await handler.handle(PAYLOAD, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'anan@example.test',
      subject: 'A seat is waiting for you at Bangkok Tech Week',
      delivery: {
        organizationId: 7,
        kind: 'waitlist-offer',
        recipientName: 'Anan',
        eventId: 'e-1',
      },
    });
    expect(sent[0].text).toContain('General × 2: ฿2,100.00');
    expect(sent[0].text).toContain('https://web.test/my/tickets/orders/o-1');
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m-1');
  });

  it('sends nothing when the organizer switched the offer email off', async () => {
    templates.isActive.mockResolvedValue(false);
    await handler.handle(PAYLOAD, ctx);
    expect(templates.isActive).toHaveBeenCalledWith(7, 'waitlist-offer');
    expect(sent).toHaveLength(0);
  });

  it('sends nothing for an offer that is no longer open', async () => {
    // Paid already, or lapsed while the message queued: "pay now" would be
    // for a seat that is theirs already, or somebody else's.
    repo.context.mockResolvedValue({ ...OPEN, paymentStatus: 'paid' });
    await handler.handle(PAYLOAD, ctx);
    expect(sent).toHaveLength(0);
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m-1');
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
      bodyEn:
        'Good news {{first_name}} — a {{ticket_type}} seat for {{event_name}}!',
    });
    await handler.handle(PAYLOAD, ctx);
    expect(
      sent[0].text.startsWith(
        'Good news Anan — a General seat for Bangkok Tech Week!',
      ),
    ).toBe(true);
    expect(sent[0].text).toContain('https://web.test/my/tickets/orders/o-1');
  });

  it('does not send twice when the message is redelivered', async () => {
    idempotency.isCompleted.mockResolvedValue(true);
    await handler.handle(PAYLOAD, ctx);
    expect(sent).toHaveLength(0);
  });
});
