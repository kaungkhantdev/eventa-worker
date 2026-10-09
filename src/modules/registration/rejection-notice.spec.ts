import {
  moneyOf,
  rejectionBody,
  rejectionSubject,
  type RejectionNotice,
} from './rejection-notice';

const NOTICE: RejectionNotice = {
  locale: 'en',
  attendeeName: 'Anan',
  eventName: 'Bangkok Tech Week',
  reference: 'ORD-AAAA1111',
  money: 'nothing-taken',
  totalSatang: 0,
  currency: 'THB',
};

describe('rejection notice (US-REG-02)', () => {
  it('says the place was not confirmed, and names the event', () => {
    expect(rejectionSubject(NOTICE)).toBe(
      'Your registration for Bangkok Tech Week was not approved',
    );
    expect(rejectionBody(NOTICE)).toContain('Bangkok Tech Week');
  });

  /**
   * The organizer's note never reaches this module — there is no field for it.
   * What takes its place is a line telling the reader who to ask and what to
   * quote, which is what somebody turned down with no explanation actually
   * needs. It is in every rejection, so the copy reads the same whether the
   * organizer wrote a note or not.
   */
  it('always tells the reader how to ask, and what to quote', () => {
    const body = rejectionBody(NOTICE);
    expect(body).toContain('contact the organizer');
    expect(body).toContain('ORD-AAAA1111');
  });

  it('tells an attendee whose money went back that it did, with the amount', () => {
    const body = rejectionBody({
      ...NOTICE,
      money: 'refunded',
      totalSatang: 210_000,
    });
    expect(body).toContain('฿2,100.00 has been refunded');
  });

  it('promises the refund that has not landed yet', () => {
    const body = rejectionBody({
      ...NOTICE,
      money: 'refund-coming',
      totalSatang: 210_000,
    });
    expect(body).toContain('฿2,100.00 will be refunded');
  });

  it('reassures an unpaid registration that nothing was charged', () => {
    expect(rejectionBody({ ...NOTICE, totalSatang: 120_000 })).toContain(
      'No payment was taken',
    );
  });

  it('says nothing about money for a free registration', () => {
    const body = rejectionBody({ ...NOTICE, money: 'none' });
    expect(body).not.toContain('payment');
    expect(body).not.toContain('refund');
  });

  it('writes to a Thai reader in Thai, money line included', () => {
    const notice: RejectionNotice = {
      ...NOTICE,
      locale: 'th',
      money: 'refunded',
      totalSatang: 210_000,
    };
    expect(rejectionSubject(notice)).toContain('ไม่ได้รับการอนุมัติ');
    expect(rejectionBody(notice)).toContain('สวัสดีคุณ Anan');
    expect(rejectionBody(notice)).toContain('฿2,100.00');
    expect(rejectionBody(notice)).toContain('คืน');
  });

  /**
   * US-MSG-02: an organizer may soften the news in their own words. The money
   * line is never theirs — see the module docstring.
   */
  it('takes the organizer’s subject and opening, and still ends Eventa’s way', () => {
    const body = rejectionBody({
      ...NOTICE,
      money: 'refund-coming',
      totalSatang: 210_000,
      subject: 'About your place at Bangkok Tech Week',
      opening: 'Anan, we could not fit you in this year.',
    });
    expect(
      rejectionSubject({
        ...NOTICE,
        subject: 'About your place at Bangkok Tech Week',
      }),
    ).toBe('About your place at Bangkok Tech Week');
    expect(body.startsWith('Anan, we could not fit you in this year.')).toBe(
      true,
    );
    expect(body).toContain('฿2,100.00 will be refunded');
    expect(body).toContain('contact the organizer');
  });
});

describe('moneyOf', () => {
  it('says nothing about money a free registration never owed', () => {
    expect(moneyOf({ totalSatang: 0, paymentStatus: 'pending' })).toBe('none');
  });

  it('reads a captured payment on a rejected order as a refund owed', () => {
    expect(moneyOf({ totalSatang: 210_000, paymentStatus: 'paid' })).toBe(
      'refund-coming',
    );
  });

  it('reads a refunded order as money already back', () => {
    expect(moneyOf({ totalSatang: 210_000, paymentStatus: 'refunded' })).toBe(
      'refunded',
    );
  });

  it.each(['pending', 'failed'])(
    'took nothing when payment is %s',
    (status) => {
      expect(moneyOf({ totalSatang: 210_000, paymentStatus: status })).toBe(
        'nothing-taken',
      );
    },
  );

  /**
   * An `ALTER TYPE payment_status ADD VALUE` upstream reaches this mirror as a
   * value it has never heard of. Money in an unknown state is money this
   * notice must not describe: silence is wrong in no case, while "no payment
   * was taken" would be a lie to somebody who is out of pocket.
   */
  it('says nothing about a payment state it does not recognise', () => {
    expect(moneyOf({ totalSatang: 210_000, paymentStatus: 'disputed' })).toBe(
      'none',
    );
  });
});
