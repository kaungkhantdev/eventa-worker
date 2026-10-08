import { confirmationSms } from './confirmation-sms';

const REFERENCE = 'ORD-7K2M9QX4';
const URL = 'https://web.test/my/tickets/orders/o-1';

const details = (
  over: Partial<Parameters<typeof confirmationSms>[0]> = {},
) => ({
  locale: 'en' as const,
  eventName: 'Bangkok Tech Week',
  reference: REFERENCE,
  ticketsUrl: URL,
  ...over,
});

describe('confirmationSms (US-DISC-06)', () => {
  it('says what it is, which booking, and where the tickets are', () => {
    const text = confirmationSms(details());
    expect(text).toContain('Bangkok Tech Week');
    expect(text).toContain(REFERENCE);
    expect(text).toContain(URL);
  });

  it('writes the text in the reader’s own language', () => {
    const text = confirmationSms(details({ locale: 'th' }));
    expect(text).toContain('ลงทะเบียน');
    expect(text).toContain(REFERENCE);
    expect(text).toContain(URL);
  });

  /**
   * Cost, not style. A single non-GSM-7 character anywhere in the body — a
   * typographic apostrophe, an ellipsis — switches the WHOLE message to UCS-2,
   * where a segment holds 70 characters instead of 160. An English
   * confirmation must stay in one segment.
   */
  it('keeps an English text inside the cheap alphabet', () => {
    // Printable ASCII is a subset of GSM-7 and the practical test here: every
    // character this copy uses is a single septet.
    expect(confirmationSms(details())).toMatch(/^[\x20-\x7E]*$/);
  });

  it('clips a long event name rather than the reference or the link', () => {
    // A 200-character name would otherwise buy several segments per attendee.
    const text = confirmationSms(details({ eventName: 'A'.repeat(200) }));
    expect(text).toContain('...');
    expect(text).not.toContain('A'.repeat(50));
    // The two things the attendee actually needs survive whole.
    expect(text).toContain(REFERENCE);
    expect(text).toContain(URL);
  });

  it('leaves a name that fits exactly alone', () => {
    const name = 'B'.repeat(40);
    expect(confirmationSms(details({ eventName: name }))).toContain(name);
    expect(confirmationSms(details({ eventName: name }))).not.toContain('...');
  });

  /**
   * A UTF-16 slice cuts a surrogate pair in half, and the orphaned half does
   * not survive the trip: `URLSearchParams` — what the Twilio transport builds
   * its request body with — serialises a lone surrogate as U+FFFD, so the
   * attendee reads a replacement character where the organizer wrote an emoji.
   */
  it('clips by character, never through an emoji', () => {
    const name = `${'A'.repeat(39)}🎉${'B'.repeat(10)}`;
    const text = confirmationSms(details({ eventName: name }));
    expect(new URLSearchParams({ Body: text }).toString()).not.toContain(
      '%EF%BF%BD',
    );
    expect(text).toContain(`${'A'.repeat(39)}🎉...`);
  });

  it('counts an emoji as ONE character when deciding to clip', () => {
    // 40 characters but 41 code units: measuring the string's `length` would
    // clip a name that fits.
    const name = `${'B'.repeat(39)}🎉`;
    const text = confirmationSms(details({ eventName: name }));
    expect(text).toContain(name);
    expect(text).not.toContain('...');
  });

  it('never reaches an attendee with an unfilled field', () => {
    for (const locale of ['en', 'th'] as const) {
      expect(confirmationSms(details({ locale }))).not.toMatch(
        /null|undefined|\{\{/,
      );
    }
  });
});
