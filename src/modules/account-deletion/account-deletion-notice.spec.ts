import {
  type ClosureNotice,
  closureBody,
  closureSubject,
} from './account-deletion-notice';

/** 17:30 UTC is 00:30 the NEXT day in Bangkok — the point of rendering in +07. */
const DELETED_AT = new Date('2026-07-31T17:30:00.000Z');

const english: ClosureNotice = {
  locale: 'en',
  name: 'Somchai',
  deletedAt: DELETED_AT,
};

const thai: ClosureNotice = { ...english, locale: 'th' };

describe('closureBody', () => {
  it('says what happened, without naming the reader', () => {
    const body = closureBody(english);

    expect(body).toMatch(/deleted/i);
    expect(body).not.toContain('Somchai');
  });

  /*
   * WHY THE GREETING CARRIES NO NAME, pinned so it is not "tidied" back.
   *
   * The name is attacker-controlled through exactly the session this notice
   * reports, and no shape rule separates a name from a sentence in a script
   * written without inter-word spaces: `safeDisplayName`'s word cap counts
   * `name.split(' ')`, so the Thai string below is ONE word. It is a complete
   * imperative — "URGENT your account was hacked, call support now" — at 48
   * code points with no digits and no punctuation, and it cleared every cap.
   * In a Thai-market product that is the primary locale.
   *
   * Any cap generous enough for a real Thai name admits it, so the position
   * went instead of the rule.
   */
  it('cannot be made to carry somebody else’s sentence', () => {
    const lure = 'ด่วนบัญชีถูกแฮกโปรดโทรฝ่ายสนับสนุนทันทีเดี๋ยวนี้';
    const body = closureBody({ ...english, name: lure });

    expect(body).not.toContain(lure);
  });

  it('writes the same notice in Thai for a Thai reader', () => {
    expect(closureSubject(thai)).toContain('ถูกลบแล้ว');
    expect(closureBody(thai)).toContain('ไม่สามารถย้อนกลับได้');
  });
});

/**
 * The name is the one attacker-controlled string in this mail, and the account
 * holder may well not have been the one who set it: eventa-api's
 * `UpdateProfileDto.name` is `@IsString() @MaxLength(200)` with no charset or
 * newline restriction, so whoever had the session that closed this account
 * could have renamed the profile first. Interpolated verbatim, a name of
 * "Somchai\n\nURGENT: … https://evil.test/fix" would put an attacker-chosen
 * line ABOVE the warning in a plain-text mail most clients auto-linkify — in a
 * notice whose own copy says no link in it restores the account.
 */
describe('a hostile name on the event', () => {
  const HOSTILE =
    'Somchai\n\nURGENT: secure your account at https://acme-support.evil.test/fix';

  it('cannot add a line to the body', () => {
    const lines = closureBody({ ...english, name: HOSTILE }).split('\n');

    expect(lines).toHaveLength(closureBody(english).split('\n').length);
  });

  it('cannot put a link in a notice that says no link helps', () => {
    const body = closureBody({ ...english, name: HOSTILE });

    expect(body).not.toMatch(/https?:/i);
    expect(body).not.toContain('evil.test');
    expect(body).not.toContain('/fix');
  });

  it('cannot add a line to the subject, where a newline is header injection', () => {
    expect(closureSubject({ ...english, name: HOSTILE })).not.toMatch(/[\r\n]/);
  });

  /** Thai copy interpolates the same name, so it gets the same guarantee. */
  it('cannot add a line to the Thai body either', () => {
    const lines = closureBody({ ...thai, name: HOSTILE }).split('\n');

    expect(lines).toHaveLength(closureBody(thai).split('\n').length);
  });

  /**
   * A name that is nothing BUT a link leaves nothing to greet with. The notice
   * is already addressed to that person, so it drops the name rather than the
   * greeting — and certainly rather than the warning.
   */
  it('greets without a name when nothing usable survives', () => {
    const body = closureBody({ ...english, name: 'https://evil.test/fix' });

    expect(body.split('\n')[0]).toBe('Hi,');
    expect(body).toMatch(/cannot be undone/i);
  });
});

/**
 * The same attack with no URL punctuation in it. A digit run needs no scheme,
 * slash or dot to become a `tel:` link on a phone, and a sentence needs no link
 * at all to answer the notice in Eventa's voice — so a name that is not
 * name-shaped is declined whole. See `common/messaging/display-name.ts`.
 */
describe('a hostile name that carries no URL punctuation', () => {
  const LURES = [
    'Ignore this, it was me, your admin',
    'Somchai call 0812345678 now',
    'Support +66 81 234 5678',
  ];

  it.each(LURES)('greets without a name rather than print %p', (name) => {
    const body = closureBody({ ...english, name });

    expect(body.split('\n')[0]).toBe('Hi,');
    expect(body).not.toContain(name);
    expect(body.split('\n')[0]).not.toMatch(/\d/u);
  });

  it.each(LURES)('greets a Thai reader without one either, for %p', (name) => {
    const body = closureBody({ ...thai, name });

    expect(body.split('\n')[0]).toBe('สวัสดี');
    expect(body).not.toContain(name);
  });
});
