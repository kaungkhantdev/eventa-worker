import { Logger } from '@nestjs/common';
import type { EmailProvider } from '../../common/email/email.provider';
import type {
  IdempotencyService,
  SentLedger,
} from '../../common/idempotency/idempotency.service';
import type { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import type { SmsProvider } from '../../common/sms/sms.provider';
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
    buyerPhone: '081-234-5678',
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
  let sms: jest.Mocked<SmsProvider>;
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
    sms = {
      enabled: true,
      send: jest.fn().mockResolvedValue(undefined),
    };
    repo = {
      loadConfirmation: jest.fn().mockResolvedValue(source()),
    } as unknown as jest.Mocked<RegistrationRepository>;
    templates = {
      isActive: jest.fn().mockResolvedValue(true),
      sendsOn: jest.fn().mockResolvedValue(true),
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
      sms,
      repo,
      templates,
      idempotency,
      receipts,
    );
  });

  afterEach(() => jest.restoreAllMocks());

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
      // Off is off on every channel: `sendsOn` reads the same `active` column
      // that `isActive` does, so the text goes silent with the email.
      templates.isActive.mockResolvedValue(false);
      templates.sendsOn.mockResolvedValue(false);
      await handle();
      expect(email.send).not.toHaveBeenCalled();
      expect(sms.send).not.toHaveBeenCalled();
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

  describe('the confirmation text (US-DISC-06)', () => {
    const sent = () => sms.send.mock.calls[0][0];

    it('texts the mobile the buyer gave, in the shape a provider accepts', async () => {
      await handle();
      expect(sent().to).toBe('+66812345678');
      expect(sent().text).toContain('ORD-7K2M9QX4');
      expect(sent().text).toContain('https://web.test/my/tickets/orders/o-1');
      expect(sent().text).toContain('Bangkok Tech Week');
    });

    it('files the text under the person, never under their number', async () => {
      // `message_deliveries` has no phone column, and the number must not be
      // smuggled into one of the text ones.
      await handle();
      expect(sent().delivery).toEqual({
        organizationId: ORG,
        kind: 'registration-confirmation',
        recipientName: 'Anan',
        recipientEmail: 'anan@example.test',
        eventId: 'e-1',
      });
    });

    it('writes the text in the reader’s language', async () => {
      repo.loadConfirmation.mockResolvedValue(source({ userLocale: 'th' }));
      await handle();
      expect(sent().text).toContain('ลงทะเบียน');
    });

    it('sends nothing when no number was given', async () => {
      // "Given I provided a mobile number" — most registrations do not.
      await handle({ buyerPhone: null });
      expect(sms.send).not.toHaveBeenCalled();
      await handle({ buyerPhone: undefined });
      expect(sms.send).not.toHaveBeenCalled();
    });

    it('sends nothing to a landline or a foreign number', async () => {
      // "and SMS is applicable". Neither can receive one, and both would be
      // billed.
      await handle({ buyerPhone: '021234567' });
      await handle({ buyerPhone: '+14155550123' });
      expect(sms.send).not.toHaveBeenCalled();
      // The email is unaffected: a number that cannot be texted is not a
      // reason to withhold somebody's ticket.
      expect(email.send).toHaveBeenCalled();
    });

    it('honours the organizer’s SMS channel, and asks about the right one', async () => {
      templates.sendsOn.mockResolvedValue(false);
      await handle();
      expect(templates.sendsOn).toHaveBeenCalledWith(
        ORG,
        'registration-confirmation',
        'sms',
      );
      expect(sms.send).not.toHaveBeenCalled();
      // One channel off is not the message off.
      expect(email.send).toHaveBeenCalled();
    });

    it('does no work at all when the deployment cannot text', async () => {
      // Production has no SMS account. Reading the database to build a text
      // nothing can send is pure waste.
      Object.defineProperty(sms, 'enabled', { value: false });
      repo.loadConfirmation.mockClear();
      await handle();
      expect(sms.send).not.toHaveBeenCalled();
      expect(templates.sendsOn).not.toHaveBeenCalled();
      // Once, for the email — not a second time for a text that cannot go.
      expect(repo.loadConfirmation).toHaveBeenCalledTimes(1);
    });

    it('refuses to text about an order whose tickets have all vanished', async () => {
      repo.loadConfirmation.mockResolvedValue(source({ tickets: [] }));
      await handle();
      expect(sms.send).not.toHaveBeenCalled();
    });

    it('goes LAST, so a courtesy text never holds back a ticket', async () => {
      const sequence: string[] = [];
      email.send.mockImplementation(() => {
        sequence.push('confirmation');
        return Promise.resolve();
      });
      receipts.send.mockImplementation(() => {
        sequence.push('receipt');
        return Promise.resolve('sent');
      });
      sms.send.mockImplementation(() => {
        sequence.push('sms');
        return Promise.resolve();
      });
      idempotency.markCompleted.mockImplementation(() => {
        sequence.push('mark');
        return Promise.resolve();
      });
      await handle();
      expect(sequence).toEqual(['confirmation', 'receipt', 'sms', 'mark']);
    });

    it('is retried on redelivery WITHOUT re-sending the email or the receipt', async () => {
      sms.send.mockRejectedValueOnce(new Error('HTTP 503'));
      await expect(handle()).rejects.toThrow('HTTP 503');
      expect(idempotency.markCompleted).not.toHaveBeenCalled();

      await handle();
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(receipts.send).toHaveBeenCalledTimes(1);
      expect(sms.send).toHaveBeenCalledTimes(2);
      expect(idempotency.markCompleted).toHaveBeenCalledWith('msg-1');
    });

    it('never puts the number in a log line', async () => {
      // The consumer logs whatever handlers log, and a phone number is PII.
      const spies = (['log', 'warn', 'debug', 'error'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
      await handle({ buyerPhone: '081-234-5678' });
      await handle({ buyerPhone: '021234567' });

      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(logged).not.toContain('812345678');
      expect(logged).not.toContain('021234567');
    });
  });
});
