import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import type { EventRecipientsRepository } from '../events/event-recipients.repository';
import { ReceiptSender } from './receipt-sender';
import type { ReceiptSource, ReceiptsRepository } from './receipts.repository';

const BAHT = 100;
const ORDER = {
  organizationId: 7,
  orderId: 'o-1',
  eventId: 'e-1',
  buyerEmail: 'anan@example.test',
};

function source(o: Partial<ReceiptSource> = {}): ReceiptSource {
  return {
    number: 'ORD-7K2M9QX4',
    buyerName: 'Anan',
    eventName: 'Bangkok Tech Week',
    paidAt: new Date('2026-08-01T03:00:00Z'),
    method: 'Card',
    seller: { name: 'Siam Events', address: null, taxId: '0105556000001' },
    lines: [
      {
        name: 'General',
        quantity: 2,
        unitSatang: 890 * BAHT,
        lineSatang: 1_780 * BAHT,
      },
    ],
    subtotalSatang: 1_780 * BAHT,
    discountSatang: 100 * BAHT,
    vatSatang: 11_540,
    totalSatang: 1_764 * BAHT,
    currency: 'THB',
    vatRate: 0.07,
    ...o,
  };
}

const NO_WORDING = {
  subjectEn: null,
  bodyEn: null,
  subjectTh: null,
  bodyTh: null,
};

describe('ReceiptSender (US-SET-10)', () => {
  let sent: EmailMessage[];
  let receipts: jest.Mocked<ReceiptsRepository>;
  let recipients: jest.Mocked<EventRecipientsRepository>;
  let templates: jest.Mocked<MessageTemplatesRepository>;
  let sender: ReceiptSender;

  beforeEach(() => {
    sent = [];
    receipts = {
      loadReceipt: jest.fn().mockResolvedValue(source()),
      emailReceiptsOn: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ReceiptsRepository>;
    recipients = {
      attendeeLocales: jest.fn().mockResolvedValue(new Map()),
      fallbackLocale: jest.fn().mockResolvedValue('en'),
    } as unknown as jest.Mocked<EventRecipientsRepository>;
    templates = {
      isActive: jest.fn().mockResolvedValue(true),
      wordingFor: jest.fn().mockResolvedValue(NO_WORDING),
    } as unknown as jest.Mocked<MessageTemplatesRepository>;
    const email: EmailProvider = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    sender = new ReceiptSender(receipts, recipients, templates, email);
  });

  it('sends the buyer an itemized receipt, logged as a payment receipt for the event', async () => {
    await expect(sender.send(ORDER)).resolves.toBe('sent');
    expect(receipts.loadReceipt).toHaveBeenCalledWith(7, 'o-1');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'anan@example.test',
      subject: 'Your receipt for Bangkok Tech Week',
      delivery: {
        organizationId: 7,
        kind: 'payment-receipt',
        recipientName: 'Anan',
        eventId: 'e-1',
      },
    });
    expect(sent[0].text).toContain('Service fee: ฿84.00');
    expect(sent[0].text).toContain('VAT 7% (included): ฿115.40');
  });

  describe('two switches, and both must be on', () => {
    it('sends nothing when the organizer has switched the receipt off', async () => {
      templates.isActive.mockResolvedValue(false);
      await expect(sender.send(ORDER)).resolves.toBe('switched-off');
      expect(templates.isActive).toHaveBeenCalledWith(7, 'payment-receipt');
      expect(receipts.loadReceipt).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
    });

    it('sends nothing when “email receipts” is off in the payment settings', async () => {
      // US-SET-10's own switch. Leaving it to the message settings alone would
      // make the one on the Payments page a switch that does nothing.
      receipts.emailReceiptsOn.mockResolvedValue(false);
      await expect(sender.send(ORDER)).resolves.toBe('switched-off');
      expect(receipts.emailReceiptsOn).toHaveBeenCalledWith(7);
      expect(sent).toHaveLength(0);
    });
  });

  it('sends nothing when no payment went through for the order', async () => {
    receipts.loadReceipt.mockResolvedValue(null);
    await expect(sender.send(ORDER)).resolves.toBe('nothing-paid');
    expect(sent).toHaveLength(0);
  });

  describe('language', () => {
    it('uses the buyer’s own preference over the event’s', async () => {
      recipients.attendeeLocales.mockResolvedValue(
        new Map([['anan@example.test', 'th']]),
      );
      recipients.fallbackLocale.mockResolvedValue('en');
      await sender.send(ORDER);
      expect(recipients.attendeeLocales).toHaveBeenCalledWith([
        'anan@example.test',
      ]);
      expect(sent[0].text).toContain('ยอดชำระทั้งหมด');
    });

    it('falls back to the event’s, then the workspace’s, language', async () => {
      recipients.fallbackLocale.mockResolvedValue('th');
      await sender.send(ORDER);
      expect(recipients.fallbackLocale).toHaveBeenCalledWith(7, 'e-1');
      expect(sent[0].subject).toBe('ใบเสร็จรับเงิน: Bangkok Tech Week');
    });
  });

  describe('the organizer’s wording (US-MSG-02)', () => {
    it('fills their merge fields and keeps the amounts', async () => {
      templates.wordingFor.mockResolvedValue({
        ...NO_WORDING,
        subjectEn: 'Receipt: {{event_name}}',
        bodyEn: 'Thanks {{first_name}}!',
      });
      await sender.send(ORDER);
      expect(templates.wordingFor).toHaveBeenCalledWith(7, 'payment-receipt');
      expect(sent[0].subject).toBe('Receipt: Bangkok Tech Week');
      expect(sent[0].text.startsWith('Thanks Anan!')).toBe(true);
      expect(sent[0].text).toContain('Total paid: ฿1,764.00');
    });

    it('gives a Thai reader Eventa’s Thai, not the organizer’s English', async () => {
      templates.wordingFor.mockResolvedValue({
        ...NO_WORDING,
        bodyEn: 'Thanks {{first_name}}!',
      });
      recipients.fallbackLocale.mockResolvedValue('th');
      await sender.send(ORDER);
      expect(sent[0].text).toContain('สวัสดีคุณ Anan');
      expect(sent[0].text).not.toContain('Thanks Anan!');
    });
  });
});
