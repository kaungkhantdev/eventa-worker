import {
  twoFactorDisabledBody,
  twoFactorDisabledSubject,
  type TwoFactorDisabledNotice,
} from './two-factor-disabled.notice';

/** 07:05 UTC is 14:05 in Bangkok — the whole point of rendering in +07. */
const OCCURRED_AT = new Date('2026-10-09T07:05:00.000Z');

const english: TwoFactorDisabledNotice = {
  name: 'Somchai',
  locale: 'en',
  occurredAt: OCCURRED_AT,
};

const thai: TwoFactorDisabledNotice = { ...english, locale: 'th' };

describe('twoFactorDisabledSubject', () => {
  it('names the change in English', () => {
    expect(twoFactorDisabledSubject(english)).toMatch(/two-factor/i);
  });

  it('names the change in Thai for a Thai reader', () => {
    expect(twoFactorDisabledSubject(thai)).toContain('สองขั้น');
  });
});

describe('twoFactorDisabledBody', () => {
  it('greets the account holder and says what happened', () => {
    const body = twoFactorDisabledBody(english);

    expect(body).toContain('Somchai');
    expect(body).toMatch(/turned off/i);
  });

  /**
   * The timestamp crosses the bus in UTC and is read by someone in Thailand.
   * Rendering it raw would have the alert contradict the clock on the wall of
   * the person deciding whether this was them, which is the one judgement the
   * email exists to support.
   */
  it('renders the time in Asia/Bangkok, not UTC', () => {
    const body = twoFactorDisabledBody(english);

    expect(body).toContain('14:05');
    expect(body).not.toContain('07:05');
  });

  /** A Thai reader expects the Buddhist era, which `th-TH` supplies. */
  it('renders the time in Thai, Buddhist era, for a Thai reader', () => {
    const body = twoFactorDisabledBody(thai);

    expect(body).toContain('2569');
    expect(body).toContain('14:05');
  });

  it('says which timezone the time is in, so it is not read as local', () => {
    expect(twoFactorDisabledBody(english)).toMatch(/bangkok/i);
  });

  /**
   * The alert matters most when the reader did NOT do this, so it has to say
   * what to do about it rather than merely report the change.
   */
  it('tells a reader who did not do this what to do', () => {
    const body = twoFactorDisabledBody(english);

    expect(body).toMatch(/password/i);
    expect(body).toMatch(/turn two-factor authentication back on/i);
  });

  it('tells a Thai reader who did not do this what to do', () => {
    expect(twoFactorDisabledBody(thai)).toContain('รหัสผ่าน');
  });

  /**
   * A timestamp this service cannot read must not cost the person their
   * security alert. The line is dropped — the same "omit rather than render
   * blank" rule the cancellation and confirmation notices follow — and the
   * warning still goes out.
   */
  it('omits the time line rather than failing when the timestamp is unreadable', () => {
    const body = twoFactorDisabledBody({
      ...english,
      occurredAt: new Date('not-a-date'),
    });

    expect(body).toMatch(/turned off/i);
    expect(body).not.toMatch(/invalid date/i);
    expect(body).not.toMatch(/\bnan\b/i);
  });
});

/**
 * The name is the one attacker-controlled string in this mail, and it is
 * controlled through precisely the stolen session this alert exists to report:
 * eventa-api's `UpdateProfileDto.name` is `@IsString() @MaxLength(200)` with no
 * charset or newline restriction. So a profile renamed to
 * "Somchai\n\nURGENT: … https://evil.test/fix" would, interpolated verbatim,
 * put an attacker-chosen line ABOVE the warning in a plain-text mail most
 * clients auto-linkify — in a mail whose own docstring says it deliberately
 * contains no links.
 */
describe('a hostile name on the event', () => {
  const HOSTILE =
    'Somchai\n\nURGENT: secure your account at https://acme-support.evil.test/fix';

  it('cannot add a line to the body', () => {
    const lines = twoFactorDisabledBody({ ...english, name: HOSTILE }).split(
      '\n',
    );

    expect(lines).toHaveLength(
      twoFactorDisabledBody(english).split('\n').length,
    );
  });

  it('cannot put a link in a mail that says it contains none', () => {
    const body = twoFactorDisabledBody({ ...english, name: HOSTILE });

    expect(body).not.toMatch(/https?:/i);
    expect(body).not.toContain('evil.test');
    expect(body).not.toContain('/fix');
  });

  it('cannot add a line to the subject, where a newline is header injection', () => {
    expect(twoFactorDisabledSubject({ ...english, name: HOSTILE })).not.toMatch(
      /[\r\n]/,
    );
  });

  /** Thai copy interpolates the same name, so it gets the same guarantee. */
  it('cannot add a line to the Thai body either', () => {
    const lines = twoFactorDisabledBody({ ...thai, name: HOSTILE }).split('\n');

    expect(lines).toHaveLength(twoFactorDisabledBody(thai).split('\n').length);
  });

  /**
   * A name that is nothing BUT a link leaves nothing to greet with. The mail is
   * already addressed to that person, so it drops the name rather than the
   * greeting — and certainly rather than the warning.
   */
  it('greets without a name when nothing usable survives', () => {
    const body = twoFactorDisabledBody({
      ...english,
      name: 'https://evil.test/fix',
    });

    expect(body.split('\n')[0]).toBe('Hi,');
    expect(body).toMatch(/turned off/i);
  });
});
