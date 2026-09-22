import type { EmailProvider } from '../../common/email/email.provider';
import type {
  IdempotencyService,
  SentLedger,
} from '../../common/idempotency/idempotency.service';
import type { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { ReceiptSender } from '../payments/receipt-sender';
import type { ConfirmationSource } from './registration.repository';
import type { RegistrationRepository } from './registration.repository';
import { RegistrationConfirmedHandler } from './registration-confirmed.handler';

const ORG = 7;
const ORDER_ID = 'o-1';
const BAHT = 100;

const ctx: MessageContext = {
  routingKey: 'registration.confirmed',
  messageId: 'msg-1',
  correlationId: 'corr-1',
};

function payload(o: Record<string, unknown> = {}) {
  return {
    version: 1,
    organizationId: ORG,
    orderId: ORDER_ID,
    reference: 'ORD-7K2M9QX4',
    eventId: 'e-1',
    buyerEmail: 'anan@example.test',
    buyerName: 'Anan',
    ticketCount: 2,
    totalSatang: 1_880 * BAHT,
    vatSatang: 12_300,
    currency: 'THB',
    isOnline: false,
    paid: true,
    ticketsUrl: 'https://web.test/my/tickets/orders/o-1',
    occurredAt: '2026-08-01T00:00:00Z',
    ...o,
  };
}

function source(o: Partial<ConfirmationSource> = {}): ConfirmationSource {
  return {
    event: {
      name: 'Bangkok Tech Week',
      startAt: new Date('2026-09-01T02:00:00Z'),
      timezone: 'Asia/Bangkok',
      venueName: 'QSNCC',
      city: 'Bangkok',
      isOnline: false,
      onlineNote: null,
      slug: 'bangkok-tech-week',
      locale: null,
    },
    orgLocale: 'en',
    userLocale: null,
    tickets: [
      { holderName: 'Anan', ticketLabel: 'General' },
      { holderName: 'Malee', ticketLabel: 'General' },
    ],
    ...o,
  };
}

describe('RegistrationConfirmedHandler (US-MSG-01)', () => {
  let email: jest.Mocked<EmailProvider>;
  let repo: jest.Mocked<RegistrationRepository>;
  let templates: jest.Mocked<MessageTemplatesRepository>;
  let idempotency: jest.Mocked<IdempotencyService>;
  let receipts: jest.Mocked<ReceiptSender>;
  let done: Set<string>;
  let handler: RegistrationConfirmedHandler;

  beforeEach(() => {
    done = new Set();
    const ledger: SentLedger = {
      wasSent: (part) => Promise.resolve(done.has(part)),
      markSent: (part) => {
        done.add(part);
        return Promise.resolve();
      },
    };
    email = { send: jest.fn().mockResolvedValue(undefined) };
    repo = {
      loadConfirmation: jest.fn().mockResolvedValue(source()),
    } as unknown as jest.Mocked<RegistrationRepository>;
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
    idempotency = {
      isCompleted: jest.fn().mockResolvedValue(false),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      recipientLedger: jest.fn().mockReturnValue(ledger),
    } as unknown as jest.Mocked<IdempotencyService>;
    receipts = {
      send: jest.fn().mockResolvedValue('sent'),
    } as unknown as jest.Mocked<ReceiptSender>;
    handler = new RegistrationConfirmedHandler(
      email,
      repo,
      templates,
      idempotency,
      receipts,
    );
  });

  const handle = (o: Record<string, unknown> = {}) =>
    handler.handle(payload(o), ctx);

  it('binds to the routing key the API publishes', () => {
    expect(handler.routingKey).toBe('registration.confirmed');
  });

  it('sends the confirmation with the tickets read LIVE, not from the message', async () => {
    await handle();
    // The buyer's email goes in too — their own language preference is looked
    // up from it, and hardcoding null there would silently ignore AC4.
    expect(repo.loadConfirmation).toHaveBeenCalledWith(
      ORG,
      ORDER_ID,
      'e-1',
      'anan@example.test',
    );
    const [sent] = email.send.mock.calls[0];
    expect(sent.to).toBe('anan@example.test');
    expect(sent.subject).toContain('Bangkok Tech Week');
    expect(sent.text).toContain('ORD-7K2M9QX4');
    expect(sent.text).toContain('฿1,880.00');
    // The link is absolute: a root-relative path is inert in a mail client.
    expect(sent.text).toContain('https://web.test/my/tickets/orders/o-1');
    // A QR token is a bearer credential and must never reach the body.
    expect(sent.text).not.toMatch(/QR-|qrToken/);
  });

  it('records completion only AFTER the email is away', async () => {
    const order: string[] = [];
    email.send.mockImplementation(() => {
      order.push('send');
      return Promise.resolve();
    });
    idempotency.markCompleted.mockImplementation(() => {
      order.push('mark');
      return Promise.resolve();
    });
    await handle();
    expect(order).toEqual(['send', 'mark']);
  });

  it('does not send twice when the message is redelivered', async () => {
    idempotency.isCompleted.mockResolvedValue(true);
    await handle();
    expect(email.send).not.toHaveBeenCalled();
  });

  describe('the organizer’s kill switch', () => {
    it('sends nothing when the message is turned off', async () => {
      templates.isActive.mockResolvedValue(false);
      await handle();
      expect(email.send).not.toHaveBeenCalled();
      expect(repo.loadConfirmation).not.toHaveBeenCalled();
    });

    it('still sends when the workspace has never touched its settings', async () => {
      // An absent row means active — a new workspace must not go silent.
      templates.isActive.mockResolvedValue(true);
      await handle();
      expect(email.send).toHaveBeenCalled();
    });
  });

  describe('language', () => {
    it('uses the attendee’s own preference OVER the event’s and the workspace’s', async () => {
      // All three set and in conflict — the only shape that pins the order.
      // With only the event nulled, swapping user/event precedence still passes.
      repo.loadConfirmation.mockResolvedValue(
        source({
          userLocale: 'th',
          orgLocale: 'en',
          event: { ...source().event, locale: 'en' },
        }),
      );
      await handle();
      expect(email.send.mock.calls[0][0].text).toContain('สวัสดีคุณ Anan');
    });

    it('uses the event’s language OVER the workspace’s', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({
          userLocale: null,
          orgLocale: 'en',
          event: { ...source().event, locale: 'th' },
        }),
      );
      await handle();
      expect(email.send.mock.calls[0][0].text).toContain('สวัสดีคุณ Anan');
    });

    it('writes the date in the reader’s language, not only the labels', async () => {
      repo.loadConfirmation.mockResolvedValue(source({ userLocale: 'th' }));
      await handle();
      const { text } = email.send.mock.calls[0][0];
      // A Thai email with an English date is half-translated; th-TH also
      // renders the Buddhist era (2569), which is what a Thai reader expects.
      expect(text).toMatch(/2569/);
      expect(text).not.toMatch(/September/);
    });

    it('writes an English date for an English reader', async () => {
      await handle();
      expect(email.send.mock.calls[0][0].text).toMatch(/September 2026/);
    });

    it('falls back to the EVENT’s language when the attendee has none', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({
          userLocale: null,
          event: { ...source().event, locale: 'th' },
        }),
      );
      await handle();
      expect(email.send.mock.calls[0][0].text).toContain('สวัสดีคุณ Anan');
    });

    it('falls back to the workspace’s language when neither is set', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({ userLocale: null, orgLocale: 'th' }),
      );
      await handle();
      expect(email.send.mock.calls[0][0].text).toContain('สวัสดีคุณ Anan');
    });
  });

  describe('never send an unfilled field', () => {
    it('omits the venue line rather than printing an empty one', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({
          event: { ...source().event, venueName: null, city: null },
        }),
      );
      await handle();
      const { text } = email.send.mock.calls[0][0];
      expect(text).not.toMatch(/null|undefined/);
      expect(text).not.toMatch(/Where:\s*$/m);
    });

    it('says Online for an online event with no note', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({
          event: { ...source().event, isOnline: true, venueName: null },
        }),
      );
      await handle();
      expect(email.send.mock.calls[0][0].text).toContain('Online');
    });

    it('names an unlabelled ticket rather than printing null', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({ tickets: [{ holderName: null, ticketLabel: null }] }),
      );
      await handle();
      expect(email.send.mock.calls[0][0].text).not.toMatch(/null|undefined/);
    });

    it('calls a free registration free instead of printing ฿0.00', async () => {
      await handle({ paid: false, totalSatang: 0 });
      const { text } = email.send.mock.calls[0][0];
      expect(text).toContain('Free registration');
      expect(text).not.toContain('฿0.00');
    });
  });

  it('refuses to send an order whose tickets have all vanished', async () => {
    // Void/refunded between commit and delivery: an email promising a ticket
    // that no longer admits anyone is worse than none.
    repo.loadConfirmation.mockResolvedValue(source({ tickets: [] }));
    await handle();
    expect(email.send).not.toHaveBeenCalled();
  });

  describe('the payment receipt (US-SET-10)', () => {
    const order = {
      organizationId: ORG,
      orderId: ORDER_ID,
      eventId: 'e-1',
      buyerEmail: 'anan@example.test',
    };

    it('follows the confirmation for a paid order', async () => {
      const sequence: string[] = [];
      email.send.mockImplementation(() => {
        sequence.push('confirmation');
        return Promise.resolve();
      });
      receipts.send.mockImplementation(() => {
        sequence.push('receipt');
        return Promise.resolve('sent');
      });
      await handle();
      expect(receipts.send).toHaveBeenCalledWith(order);
      expect(sequence).toEqual(['confirmation', 'receipt']);
    });

    it('is not sent for a free registration', async () => {
      await handle({ paid: false, totalSatang: 0 });
      expect(receipts.send).not.toHaveBeenCalled();
    });

    it('still goes when the confirmation is switched off', async () => {
      // Two messages, two switches: turning off one is not turning off both.
      templates.isActive.mockResolvedValue(false);
      await handle();
      expect(email.send).not.toHaveBeenCalled();
      expect(receipts.send).toHaveBeenCalledWith(order);
    });

    it('still goes when the tickets have since been voided', async () => {
      // A receipt is about the money, and the money was taken. Were it given
      // back, the sender finds no settled payment and sends nothing itself.
      repo.loadConfirmation.mockResolvedValue(source({ tickets: [] }));
      await handle();
      expect(receipts.send).toHaveBeenCalledWith(order);
    });

    it('is retried on redelivery WITHOUT sending the confirmation twice', async () => {
      receipts.send.mockRejectedValueOnce(new Error('SMTP down'));
      await expect(handle()).rejects.toThrow('SMTP down');
      expect(idempotency.markCompleted).not.toHaveBeenCalled();

      await handle();
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(receipts.send).toHaveBeenCalledTimes(2);
      expect(idempotency.markCompleted).toHaveBeenCalledWith('msg-1');
    });

    it('marks the message done only once the receipt is away too', async () => {
      const sequence: string[] = [];
      receipts.send.mockImplementation(() => {
        sequence.push('receipt');
        return Promise.resolve('sent');
      });
      idempotency.markCompleted.mockImplementation(() => {
        sequence.push('mark');
        return Promise.resolve();
      });
      await handle();
      expect(sequence).toEqual(['receipt', 'mark']);
    });
  });
});
