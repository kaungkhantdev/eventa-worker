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
