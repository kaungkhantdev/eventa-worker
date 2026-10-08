import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { EventRecipientsRepository } from '../events/event-recipients.repository';
import { WaitlistOfferExpiredHandler } from './waitlist-offer-expired.handler';
import type { WaitlistRepository } from './waitlist.repository';

const ctx: MessageContext = {
  routingKey: 'waitlist.offer_expired',
  messageId: 'm-2',
};
const PAYLOAD = {
  version: 1,
  organizationId: 7,
  orderId: 'o-1',
  reference: 'ORD-AAAA1111',
  eventId: 'e-1',
  buyerEmail: 'anan@example.test',
  buyerName: 'Anan',
};

describe('WaitlistOfferExpiredHandler (US-REG-04)', () => {
  let sent: EmailMessage[];
  let templates: jest.Mocked<MessageTemplatesRepository>;
  let recipients: jest.Mocked<EventRecipientsRepository>;
  let idempotency: jest.Mocked<IdempotencyService>;
  let handler: WaitlistOfferExpiredHandler;

  beforeEach(() => {
    sent = [];
    const email: EmailProvider = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    const repo = {
      context: jest.fn().mockResolvedValue({
        eventName: 'Bangkok Tech Week',
        timezone: 'Asia/Bangkok',
        status: 'expired',
        paymentStatus: 'pending',
        offerExpiresAt: new Date('2026-08-02T03:00:00Z'),
      }),
    } as unknown as WaitlistRepository;
    templates = {
      isActive: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<MessageTemplatesRepository>;
    recipients = {
      attendeeLocales: jest.fn().mockResolvedValue(new Map()),
      fallbackLocale: jest.fn().mockResolvedValue('en'),
    } as unknown as jest.Mocked<EventRecipientsRepository>;
    idempotency = {
      isCompleted: jest.fn().mockResolvedValue(false),
      markCompleted: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IdempotencyService>;
    handler = new WaitlistOfferExpiredHandler(
      email,
      repo,
      templates,
      recipients,
      idempotency,
    );
  });

  it('tells the attendee their offer lapsed, logged under its own kind', async () => {
    await handler.handle(PAYLOAD, ctx);
    expect(handler.routingKey).toBe('waitlist.offer_expired');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'anan@example.test',
      subject: 'Your waitlist offer for Bangkok Tech Week has expired',
      delivery: { kind: 'waitlist-offer-expired', eventId: 'e-1' },
    });
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m-2');
  });

  it('says nothing when the offer email itself is switched off', async () => {
    // Somebody never told of an offer should not be told it expired.
    templates.isActive.mockResolvedValue(false);
    await handler.handle(PAYLOAD, ctx);
    expect(templates.isActive).toHaveBeenCalledWith(7, 'waitlist-offer');
    expect(sent).toHaveLength(0);
  });

  it('writes in the attendee’s language', async () => {
    recipients.fallbackLocale.mockResolvedValue('th');
    await handler.handle(PAYLOAD, ctx);
    expect(sent[0].text).toContain('สวัสดีคุณ Anan');
  });
});
