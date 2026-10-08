import {
  type RefundNotice,
  buyerBody,
  describeReason,
  organizerBody,
} from './refund-notice';

/**
 * Every reason code eventa-api puts on `payment.refund_required` — its
 * `REFUND_REASON` in checkout.repository.ts, plus the duplicate payment. Keep
 * this list in step with it: a code missing here reaches a Thai buyer in
 * English.
 */
const API_REASON_CODES = [
  'duplicate_payment',
  'soldout',
  'seats_unavailable',
  'seats_released',
  'seat_mismatch',
  'tier_removed',
  'order_closed',
] as const;

const THAI = /[฀-๿]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

const notice = (o: Partial<RefundNotice> = {}): RefundNotice => ({
  reference: 'ORD-7K2M9QX4',
  eventName: 'Bangkok Tech Week',
  amountSatang: 188_000,
  currency: 'THB',
  reason: 'soldout',
  locale: 'en',
  ...o,
});

/** The line of the buyer's body that says why. */
const reasonLine = (body: string, label: string): string =>
  body.split('\n').find((line) => line.startsWith(label)) ?? '';

describe('the refund notice’s reason (US-FIN-02)', () => {
  describe.each(API_REASON_CODES)('%s', (code) => {
    it('reads as English words for an English reader, never as the code', () => {
      const said = describeReason(code, 'en');
      expect(said).not.toContain('_');
      expect(said).toMatch(LATIN_WORD);
    });

    it('reads as Thai for a Thai reader — not an English sentence inside a Thai email', () => {
      const said = describeReason(code, 'th');
      expect(said).toMatch(THAI);
      expect(said).not.toMatch(LATIN_WORD);
    });
  });

  it('writes the Thai buyer’s reason line in Thai', () => {
    const body = buyerBody(notice({ locale: 'th', reason: 'seats_released' }));
    const line = reasonLine(body, 'สาเหตุ:');
    expect(line).toMatch(THAI);
    expect(line).not.toMatch(LATIN_WORD);
  });

  it('ends the English reason line with one full stop, not two', () => {
    const body = buyerBody(notice({ reason: 'seats_released' }));
    expect(reasonLine(body, 'What happened:')).toMatch(/[^.]\.$/);
  });

  it('keeps an older sentence-shaped reason from ending in two full stops', () => {
    // What the API sent before it sent codes, still possibly in a queue.
    const body = buyerBody(
      notice({
        reason: 'The tickets sold out while the payment was being made.',
      }),
    );
    expect(body).not.toContain('..');
  });

  it('still reads as words for a code it does not know yet, in English', () => {
    expect(describeReason('something_new_from_the_api', 'en')).toBe(
      'something new from the api',
    );
  });

  it('falls back to a plain Thai sentence for a code it does not know yet', () => {
    const said = describeReason('something_new_from_the_api', 'th');
    expect(said).toMatch(THAI);
    expect(said).not.toMatch(LATIN_WORD);
  });

  it('says the registration could not be completed when no reason came', () => {
    expect(describeReason(undefined, 'en')).toMatch(/could not be completed/);
    expect(describeReason(undefined, 'th')).toMatch(THAI);
  });

  it('writes the organizer’s alert in English, whatever the event’s language', () => {
    const body = organizerBody(notice({ locale: 'th', reason: 'soldout' }));
    expect(reasonLine(body, 'Reason:')).toMatch(/sold out/);
  });
});
