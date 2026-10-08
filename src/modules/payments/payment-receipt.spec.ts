import {
  type PaymentReceipt,
  receiptBody,
  receiptSubject,
  serviceFeeOf,
} from './payment-receipt';

const BAHT = 100;

/**
 * Two General at ฿890, ฿100 off, a 5% fee on the rest (฿84), VAT included:
 * 1,780 − 100 + 84 = 1,764, of which VAT at 7/107 is ฿115.40.
 */
function receipt(o: Partial<PaymentReceipt> = {}): PaymentReceipt {
  return {
    locale: 'en',
    buyerName: 'Anan',
    eventName: 'Bangkok Tech Week',
    number: 'ORD-7K2M9QX4',
    paidAt: new Date('2026-08-01T03:00:00Z'),
    method: 'Card',
    seller: {
      name: 'Siam Events Co., Ltd.',
      address: '99 Rama IV Rd, Bangkok 10500',
      taxId: '0105556000001',
    },
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
    serviceFeeSatang: 84 * BAHT,
    totalSatang: 1_764 * BAHT,
    vatSatang: 11_540,
    vatRate: 0.07,
    currency: 'THB',
    ...o,
  };
}

describe('payment receipt (US-SET-10, US-MSG-01)', () => {
  describe('itemized', () => {
    it('prints each ticket line with its quantity, unit price and amount', () => {
      expect(receiptBody(receipt())).toContain(
        'General × 2 @ ฿890.00: ฿1,780.00',
      );
    });

    it('prints the discount, the service fee and the total paid', () => {
      const text = receiptBody(receipt());
      expect(text).toContain('Discount: −฿100.00');
      expect(text).toContain('Service fee: ฿84.00');
      expect(text).toContain('Total paid: ฿1,764.00');
    });

    it('leaves out a discount or a fee that was not charged', () => {
      // "Discount: ฿0.00" on a receipt reads as a discount that failed to apply.
      const text = receiptBody(
        receipt({
          discountSatang: 0,
          serviceFeeSatang: 0,
          totalSatang: 1_780 * BAHT,
        }),
      );
      expect(text).not.toContain('Discount');
      expect(text).not.toContain('Service fee');
    });
  });

  describe('VAT', () => {
    it('splits the total into the amount before VAT and the VAT recorded on the order', () => {
      const text = receiptBody(receipt());
      // Reproduced from the ledger, never recomputed: 1,764.00 − 115.40.
      expect(text).toContain('Amount excluding VAT: ฿1,648.60');
      expect(text).toContain('VAT 7% (included): ฿115.40');
      expect(text).toContain('Prices include VAT');
    });

    it('prints no VAT lines for an order that carried none', () => {
      // A workspace that charges no VAT must not issue a document saying it did.
      const text = receiptBody(receipt({ vatSatang: 0, vatRate: 0 }));
      expect(text).not.toMatch(/VAT/);
    });
  });

  describe('the seller', () => {
    it('names the organizer with their address and tax ID', () => {
      const text = receiptBody(receipt());
      expect(text).toContain('Siam Events Co., Ltd.');
      expect(text).toContain('99 Rama IV Rd, Bangkok 10500');
      expect(text).toContain('Tax ID: 0105556000001');
    });

    it('omits an address or tax ID that is not on file, rather than printing a blank', () => {
      const text = receiptBody(
        receipt({
          seller: { name: 'Siam Events', address: null, taxId: null },
        }),
      );
      expect(text).toContain('Siam Events');
      expect(text).not.toContain('Tax ID');
      expect(text).not.toMatch(/null|undefined/);
    });
  });

  it('carries the receipt number, the date paid in Bangkok, and how it was paid', () => {
    const text = receiptBody(
      // 23:30 UTC is already the next morning in Bangkok.
      receipt({ paidAt: new Date('2026-07-31T23:30:00Z') }),
    );
    expect(text).toContain('Receipt no.: ORD-7K2M9QX4');
    expect(text).toContain('Date paid: 1 August 2026');
    expect(text).toContain('Paid by: Card');
    expect(text).toContain('Billed to: Anan');
  });

  describe('in Thai', () => {
    const text = receiptBody(
      receipt({ locale: 'th', method: 'Bank transfer' }),
    );

    it('writes every label in Thai', () => {
      expect(text).toContain('สวัสดีคุณ Anan');
      expect(text).toContain('เลขที่ใบเสร็จ: ORD-7K2M9QX4');
      expect(text).toContain('ยอดชำระทั้งหมด: ฿1,764.00');
      expect(text).toContain('ภาษีมูลค่าเพิ่ม 7% (รวมในราคาแล้ว): ฿115.40');
      expect(text).not.toMatch(/Total paid|Receipt no\./);
    });

    it('names the payment method in Thai', () => {
      expect(text).toContain('ชำระโดย: โอนเงินผ่านธนาคาร');
    });

    it('dates it in the Buddhist era a Thai reader expects', () => {
      expect(text).toMatch(/2569/);
    });
  });

  describe('the organizer’s wording (US-MSG-02)', () => {
    it('replaces only the opening — the amounts are always Eventa’s', () => {
      const text = receiptBody(
        receipt({ opening: 'Thanks for coming to Bangkok Tech Week!' }),
      );
      expect(text.startsWith('Thanks for coming to Bangkok Tech Week!')).toBe(
        true,
      );
      expect(text).not.toContain('Hi Anan');
      expect(text).toContain('Total paid: ฿1,764.00');
      expect(text).toContain('VAT 7% (included): ฿115.40');
    });

    it('uses the organizer’s subject when there is one', () => {
      expect(receiptSubject(receipt({ subject: 'Your receipt' }))).toBe(
        'Your receipt',
      );
      expect(receiptSubject(receipt())).toBe(
        'Your receipt for Bangkok Tech Week',
      );
    });
  });

  describe('serviceFeeOf', () => {
    it('is what the total adds on top of the discounted tickets', () => {
      // The order stores subtotal, discount and total; checkout priced them
      // so that subtotal − discount + fee = total, so the fee is exact.
      expect(
        serviceFeeOf({
          subtotalSatang: 1_780 * BAHT,
          discountSatang: 100 * BAHT,
          totalSatang: 1_764 * BAHT,
        }),
      ).toBe(84 * BAHT);
    });

    it('is nothing when the order had no fee', () => {
      expect(
        serviceFeeOf({
          subtotalSatang: 500 * BAHT,
          discountSatang: 0,
          totalSatang: 500 * BAHT,
        }),
      ).toBe(0);
    });
  });
});
