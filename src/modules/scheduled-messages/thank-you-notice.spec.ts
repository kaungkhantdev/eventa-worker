import {
  surveyUrlFor,
  thankYouBody,
  thankYouSubject,
} from './thank-you-notice';

const base = {
  attendeeName: 'Anan',
  eventName: 'Bangkok Summit 2026',
  surveyUrl: 'https://web.test/portal/survey?event=e-1',
};

describe('the post-event thank-you (US-MSG-08)', () => {
  it('thanks them in English, with the link', () => {
    const body = thankYouBody({ ...base, locale: 'en' });
    expect(body).toContain('Hi Anan');
    expect(body).toContain('Bangkok Summit 2026');
    expect(body).toContain('https://web.test/portal/survey?event=e-1');
  });

  it('thanks them in Thai — not English with a Thai name in it', () => {
    const body = thankYouBody({ ...base, locale: 'th' });
    expect(body).toContain('สวัสดีคุณ Anan');
    expect(body).not.toMatch(/Thanks for/);
    expect(thankYouSubject({ ...base, locale: 'th' })).toMatch(/ขอบคุณ/);
  });

  it('keeps the survey link whatever the organizer wrote', () => {
    // The link is the reason the message exists. An organizer rewriting the
    // greeting must not be able to send a thank-you nobody can act on.
    for (const locale of ['en', 'th'] as const) {
      const body = thankYouBody({ ...base, locale, opening: 'Cheers!' });
      expect(body).toContain('Cheers!');
      expect(body).toContain(base.surveyUrl);
    }
  });
});

describe('the survey link', () => {
  it('is absolute — a root-relative link is dead in a mail client', () => {
    expect(surveyUrlFor('https://web.test', 'e-1')).toBe(
      'https://web.test/portal/survey?event=e-1',
    );
  });

  it('does not double the slash when the base ends in one', () => {
    expect(surveyUrlFor('https://web.test/', 'e-1')).toBe(
      'https://web.test/portal/survey?event=e-1',
    );
  });
});

/**
 * A buyer's own name with a line break in it. eventa-api's `BuyerDto.name` is
 * `@IsString() @IsNotEmpty() @MaxLength(120)` — no charset rule and no newline
 * rule — so this is a name the API accepts and the bus delivers.
 *
 * Built rather than written as an escape so the assertion below cannot pass by
 * the source having been normalised.
 */
const LINE_BREAK = String.fromCodePoint(0x0a);
const NAME_THAT_ADDS_A_LINE =
  'Somchai' + LINE_BREAK + 'Subject: Your Eventa account is locked';

describe('free text that would add a line of its own', () => {
  it('adds no line to the body', () => {
    const benign = thankYouBody({
      ...base,
      locale: 'en',
      attendeeName: 'Somchai',
    }).split(LINE_BREAK).length;
    const hostile = thankYouBody({
      ...base,
      locale: 'en',
      attendeeName: NAME_THAT_ADDS_A_LINE,
    }).split(LINE_BREAK).length;
    expect(hostile).toBe(benign);
  });

  it('never breaks the subject, where a second line is a header', () => {
    expect(
      thankYouSubject({
        ...base,
        locale: 'en',
        subject: NAME_THAT_ADDS_A_LINE,
      }),
    ).not.toContain(LINE_BREAK);
  });
});
