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
  it('greets the account holder and says the account is closed', () => {
    const body = closureBody(english);

    expect(body).toContain('Somchai');
    expect(body).toMatch(/deleted/i);
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
