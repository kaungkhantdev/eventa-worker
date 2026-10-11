import { cancellationBody, cancellationSubject } from './cancellation-notice';

const base = {
  attendeeName: 'Anan',
  eventName: 'Bangkok Summit 2026',
  reason: 'Venue flooded',
};

describe('the cancellation notice, in the reader’s language (US-EVT-08)', () => {
  it('writes English for an English reader', () => {
    const body = cancellationBody({ ...base, locale: 'en' });
    expect(cancellationSubject({ ...base, locale: 'en' })).toContain(
      'Bangkok Summit 2026',
    );
    expect(body).toContain('Hi Anan');
    expect(body).toContain('Venue flooded');
  });

  it('writes Thai for a Thai reader — not English with a Thai name in it', () => {
    const body = cancellationBody({ ...base, locale: 'th' });
    expect(body).toContain('สวัสดีคุณ Anan');
    expect(body).not.toMatch(/We're sorry/);
    expect(cancellationSubject({ ...base, locale: 'th' })).toMatch(/ยกเลิก/);
  });

  it('leaves the reason line out when the organizer gave none', () => {
    // "Reason: " with nothing after it is a field left unfilled.
    const body = cancellationBody({ ...base, reason: '', locale: 'en' });
    expect(body).not.toMatch(/Reason:/);
  });

  describe('the organizer’s own wording', () => {
    it('replaces the explanation with what they wrote', () => {
      const body = cancellationBody({
        ...base,
        locale: 'en',
        opening: 'We had to call it off, Anan.',
      });
      expect(body).toContain('We had to call it off, Anan.');
      expect(body).not.toContain('Hi Anan');
    });

    it('never replaces the refund line, in either language', () => {
      // Somebody whose event was cancelled needs to know their money is
      // coming back. That is not a sentence to leave to whoever was editing a
      // template at the time.
      for (const locale of ['en', 'th'] as const) {
        const body = cancellationBody({ ...base, locale, opening: 'Off.' });
        expect(body.split('\n').at(-1)).toMatch(
          locale === 'en' ? /refund/ : /คืนเงิน/,
        );
      }
    });

    it('uses the organizer’s subject when they wrote one', () => {
      expect(
        cancellationSubject({ ...base, locale: 'en', subject: 'Called off' }),
      ).toBe('Called off');
    });
  });
  describe('somebody whose registration still awaits approval (US-REG-02)', () => {
    it('tells them it was still waiting, and that a payment comes back — in English', () => {
      const body = cancellationBody({
        ...base,
        locale: 'en',
        awaitingApproval: true,
      });
      const last = body.split('\n').at(-1) ?? '';
      expect(last).toMatch(/waiting for the organizer.s approval/i);
      expect(last).toMatch(/if you paid for it/i);
      expect(last).toMatch(/refund/i);
      // Not the ticket holder's line: they never had a ticket.
      expect(body).not.toMatch(/purchased a ticket/);
    });

    it('and in Thai, for a Thai reader', () => {
      const body = cancellationBody({
        ...base,
        locale: 'th',
        awaitingApproval: true,
      });
      const last = body.split('\n').at(-1) ?? '';
      expect(last).toMatch(/รอการอนุมัติ/);
      expect(last).toMatch(/คืนเงิน/);
      expect(last).not.toMatch(/[A-Za-z]{3,}/);
    });

    it('keeps that line Eventa’s even under the organizer’s own wording', () => {
      const body = cancellationBody({
        ...base,
        locale: 'en',
        awaitingApproval: true,
        opening: 'Off.',
      });
      expect(body.split('\n').at(-1)).toMatch(/if you paid for it/i);
    });
  });
});

/**
 * A buyer's own name, with a lure and a line break in it. `orders.buyer_name`
 * is `@IsString() @IsNotEmpty() @MaxLength(120)` in eventa-api's `BuyerDto` —
 * no charset, no newline restriction — so this is a name the API accepts.
 */
const NAME_WITH_A_LINE_BREAK =
  'Somchai\nSubject: Your Eventa account is locked, call 0812345678';

describe('a name that is not one', () => {
  it('adds no line to the body', () => {
    const lines = (attendeeName: string): number =>
      cancellationBody({ ...base, attendeeName, locale: 'en' }).split('\n')
        .length;
    expect(lines(NAME_WITH_A_LINE_BREAK)).toBe(lines('Somchai'));
  });

  it('never breaks the subject, where a second line is a header', () => {
    const subject = cancellationSubject({
      ...base,
      locale: 'en',
      subject: `${NAME_WITH_A_LINE_BREAK} — cancelled`,
    });
    expect(subject).not.toMatch(/[\r\n]/);
  });
});
