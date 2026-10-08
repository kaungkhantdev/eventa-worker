import {
  type OfferNotice,
  expiredBody,
  expiredSubject,
  offerBody,
  offerStillOpen,
  offerSubject,
} from './waitlist-notice';

const UNTIL = new Date('2026-08-02T03:00:00.000Z');

function offer(o: Partial<OfferNotice> = {}): OfferNotice {
  return {
    locale: 'en',
    name: 'Anan',
    eventName: 'Bangkok Tech Week',
    ticketTypeName: 'General',
    ticketCount: 2,
    totalSatang: 210_000,
    currency: 'THB',
    offerExpiresAt: UNTIL,
    timezone: 'Asia/Bangkok',
    payUrl: 'https://web.test/my/tickets/orders/o-1',
    ...o,
  };
}

describe('waitlist notices (US-REG-04)', () => {
  describe('the offer', () => {
    it('says which seats are held, what they cost, and links to pay', () => {
      const text = offerBody(offer());
      expect(text).toContain('Hi Anan,');
      expect(text).toContain('General × 2: ฿2,100.00');
      expect(text).toContain('https://web.test/my/tickets/orders/o-1');
    });

    it('gives the deadline on the event’s own clock', () => {
      // 03:00 UTC is 10:00 in Bangkok, on Sunday 2 August.
      expect(offerBody(offer())).toMatch(/Sunday, 2 August 2026 at 10:00/);
    });

    it('says what happens if it is not taken up', () => {
      expect(offerBody(offer())).toMatch(/next person on the waitlist/);
    });

    it('writes it all in Thai for a Thai reader, Buddhist era included', () => {
      const text = offerBody(offer({ locale: 'th' }));
      expect(text).toContain('สวัสดีคุณ Anan');
      expect(text).toMatch(/2569/);
      expect(text).not.toMatch(/Hi Anan|waitlist/);
      expect(offerSubject(offer({ locale: 'th' }))).toContain(
        'Bangkok Tech Week',
      );
    });

    it('lets the organizer reword the opening, never the deadline or the link', () => {
      const text = offerBody(offer({ opening: 'Your wait is over!' }));
      expect(text.startsWith('Your wait is over!')).toBe(true);
      expect(text).not.toContain('Hi Anan');
      expect(text).toContain('https://web.test/my/tickets/orders/o-1');
      expect(text).toMatch(/2 August 2026/);
    });

    it('uses the organizer’s subject when there is one', () => {
      expect(offerSubject(offer({ subject: 'A seat for you' }))).toBe(
        'A seat for you',
      );
      expect(offerSubject(offer())).toBe(
        'A seat is waiting for you at Bangkok Tech Week',
      );
    });
  });

  describe('the lapse', () => {
    it('says the seat went to the next person, and that they are off the list', () => {
      const text = expiredBody({
        locale: 'en',
        name: 'Anan',
        eventName: 'Bangkok Tech Week',
      });
      expect(text).toContain('Hi Anan,');
      expect(text).toMatch(/next person on the waitlist/);
      expect(text).toMatch(/no longer on the waitlist/);
      expect(
        expiredSubject({ locale: 'en', name: 'Anan', eventName: 'BTW' }),
      ).toBe('Your waitlist offer for BTW has expired');
    });

    it('is written in Thai for a Thai reader', () => {
      const text = expiredBody({
        locale: 'th',
        name: 'Anan',
        eventName: 'Bangkok Tech Week',
      });
      expect(text).toContain('สวัสดีคุณ Anan');
      expect(text).not.toMatch(/waitlist/);
    });
  });

  describe('offerStillOpen', () => {
    const NOW = new Date('2026-08-01T03:00:00.000Z');
    const open = {
      status: 'pending' as const,
      paymentStatus: 'pending' as const,
      offerExpiresAt: UNTIL,
    };

    it('is open while unpaid and inside the window', () => {
      expect(offerStillOpen(open, NOW)).toBe(true);
    });

    it('is closed once paid, lapsed, or past the deadline', () => {
      // A relay running behind must not send "pay now" for a seat that is
      // already theirs, or already somebody else's.
      expect(offerStillOpen({ ...open, paymentStatus: 'paid' }, NOW)).toBe(
        false,
      );
      expect(offerStillOpen({ ...open, status: 'expired' }, NOW)).toBe(false);
      expect(offerStillOpen(open, new Date(UNTIL.getTime() + 1))).toBe(false);
      expect(offerStillOpen({ ...open, offerExpiresAt: null }, NOW)).toBe(
        false,
      );
    });
  });
});
