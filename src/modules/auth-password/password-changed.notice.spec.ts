import {
  passwordChangedBody,
  passwordChangedSubject,
  type PasswordChangedNotice,
} from './password-changed.notice';
import type { Locale } from '../../db/schema/events';

/** 07:05 UTC is 14:05 in Bangkok — the whole point of rendering in +07. */
const OCCURRED_AT = new Date('2026-10-09T07:05:00.000Z');

const english: PasswordChangedNotice = {
  name: 'Somchai',
  locale: 'en',
  occurredAt: OCCURRED_AT,
  otherSessionsSignedOut: 4,
};

const thai: PasswordChangedNotice = { ...english, locale: 'th' };

describe('passwordChangedSubject', () => {
  it('names the change in English', () => {
    expect(passwordChangedSubject(english)).toMatch(/password/i);
  });

  it('names the change in Thai for a Thai reader', () => {
    expect(passwordChangedSubject(thai)).toContain('รหัสผ่าน');
  });
});

describe('passwordChangedBody', () => {
  it('says what happened, without naming the reader', () => {
    const body = passwordChangedBody(english);

    expect(body).toMatch(/password was changed/i);
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
    const body = passwordChangedBody({ ...english, name: lure });

    expect(body).not.toContain(lure);
  });

  /**
   * The timestamp crosses the bus in UTC and is read by someone in Thailand.
   * Rendering it raw would have the notice contradict the clock on the wall of
   * the person deciding whether this was them, which is the one judgement the
   * email exists to support.
   */
  it('renders the time in Asia/Bangkok, not UTC', () => {
    const body = passwordChangedBody(english);

    expect(body).toContain('14:05');
    expect(body).not.toContain('07:05');
  });

  /** A Thai reader expects the Buddhist era, which `th-TH` supplies. */
  it('renders the time in Thai, Buddhist era, for a Thai reader', () => {
    const body = passwordChangedBody(thai);

    expect(body).toContain('2569');
    expect(body).toContain('14:05');
  });

  it('says which timezone the time is in, so it is not read as local', () => {
    expect(passwordChangedBody(english)).toMatch(/bangkok/i);
  });

  /**
   * The other half of what the reader needs. The same operation signed their
   * other sign-ins out, they did not ask for that separately, and for a reader
   * who did NOT change their password the count is the measure of how far in
   * somebody else already was.
   */
  it('says how many other sign-ins were signed out', () => {
    const body = passwordChangedBody(english);

    expect(body).toContain('4');
    expect(body).toMatch(/signed out/i);
  });

  it('says it in Thai for a Thai reader', () => {
    const body = passwordChangedBody(thai);

    expect(body).toContain('4');
    expect(body).toContain('ออกจากระบบ');
  });

  it('counts one other sign-in in the singular', () => {
    const body = passwordChangedBody({ ...english, otherSessionsSignedOut: 1 });

    expect(body).toMatch(/one other sign-in/i);
    expect(body).not.toMatch(/sign-ins/i);
  });

  /*
   * Sign-ins, never devices. The number comes from rows in `auth_sessions`,
   * and the same laptop signing in again after its refresh token lapsed is a
   * second row — so "2 other devices" could be one desk. The count is worth
   * printing, because it is how a reader judges how far somebody else already
   * was, but only said as the thing it actually measures.
   */
  it('never counts in devices', () => {
    for (const count of [1, 2, 12]) {
      const body = passwordChangedBody({
        ...english,
        otherSessionsSignedOut: count,
      });

      // The COUNT sentence specifically. "signs out every device" elsewhere is
      // both true and the right word — a reset really does end all of them —
      // so this targets the phrasing that attaches a number to the noun.
      expect(body).not.toMatch(/\d+ other devices?/i);
      expect(body).not.toMatch(/one other device/i);
    }
  });

  /**
   * `0` is a real answer, not a missing one: the account had nothing else
   * signed in. Printing "0 other devices were signed out" would make the
   * reader hunt for a meaning that is not there, so the sentence goes instead
   * of the number — the producer's own event docstring asks for exactly this.
   */
  it('drops the sentence rather than printing a zero', () => {
    const body = passwordChangedBody({ ...english, otherSessionsSignedOut: 0 });

    expect(body).not.toMatch(/signed out/i);
    // Not "contains no 0" — the Bangkok timestamp is full of digits. The claim
    // is narrower and exact: the sentence about other devices is not there.
    expect(body).toMatch(/password was changed/i);
  });

  /**
   * A producer that stops sending the count must cost the reader one sentence,
   * never the notice: the change, the time and the advice are all still true
   * without it.
   */
  it('drops the sentence when the count is absent entirely', () => {
    const body = passwordChangedBody({
      ...english,
      otherSessionsSignedOut: undefined,
    });

    expect(body).not.toMatch(/signed out/i);
    expect(body).not.toMatch(/undefined|nan/i);
    expect(body).toMatch(/password was changed/i);
  });

  /**
   * The notice matters most when the reader did NOT do this — and unlike the
   * two-factor alert, "change your password" is not advice they can act on,
   * because the person who changed it is the one who knows it. So it has to
   * name the one route back in that does not need the current password.
   */
  it('tells a reader who did not do this what to do', () => {
    const body = passwordChangedBody(english);

    expect(body).toMatch(/reset your password/i);
    expect(body).toMatch(/sign-in page/i);
  });

  it('tells a Thai reader who did not do this what to do', () => {
    const body = passwordChangedBody(thai);

    expect(body).toContain('ลืมรหัสผ่าน');
  });

  /**
   * A security notice that trains its reader to click a link in a security
   * notice is the phishing lure it was written to warn about, so the whole
   * genre carries none — and `identity.password_changed` deliberately ships no
   * URL to put in one.
   */
  it('contains no link', () => {
    expect(passwordChangedBody(english)).not.toMatch(/https?:/i);
    expect(passwordChangedBody(thai)).not.toMatch(/https?:/i);
  });

  /**
   * A timestamp this service cannot read must not cost the person their
   * notice. The line is dropped — the same "omit rather than render blank"
   * rule the two-factor and cancellation notices follow — and the rest, which
   * is still true, still goes out.
   */
  it('omits the time line rather than failing when the timestamp is unreadable', () => {
    const body = passwordChangedBody({
      ...english,
      occurredAt: new Date('not-a-date'),
    });

    expect(body).toMatch(/password was changed/i);
    expect(body).not.toMatch(/invalid date/i);
    expect(body).not.toMatch(/\bnan\b/i);
  });

  /**
   * The copy table is a `Record<Locale, Copy>` indexed by a value this service
   * only MIRRORS from eventa-api's pgEnum, and Drizzle maps no enum values on
   * the way in — so one `ALTER TYPE locale ADD VALUE` upstream arrives as a
   * key this table does not have. Indexing it threw a `TypeError` while
   * building a subject once, before the send and with no warn line, and the
   * message rode the retry ladder into the dead-letter queue in silence.
   */
  it('falls back to the default language rather than throwing on an unknown locale', () => {
    const unknown = { ...english, locale: 'ja' as Locale };

    expect(passwordChangedSubject(unknown)).toMatch(/password/i);
    expect(passwordChangedBody(unknown)).toMatch(/password was changed/i);
  });
});

/**
 * The name is the one attacker-controlled string in this mail, and it is
 * controlled through precisely the session this notice exists to report:
 * eventa-api's `UpdateProfileDto.name` is `@IsString() @MaxLength(200)` with no
 * charset or newline restriction. Interpolated verbatim, a profile renamed to
 * "Somchai\n\nURGENT: … https://evil.test/fix" would put an attacker's own
 * line, and a host most mail clients turn into a link, ABOVE Eventa's warning —
 * in a mail that contains no links of its own.
 */
describe('a hostile name on the event', () => {
  const HOSTILE =
    'Somchai\n\nURGENT: secure your account at https://acme-support.evil.test/fix';

  it('cannot add a line to the body', () => {
    const lines = passwordChangedBody({ ...english, name: HOSTILE }).split(
      '\n',
    );

    expect(lines).toHaveLength(passwordChangedBody(english).split('\n').length);
  });

  it('cannot put a link in a mail that says it contains none', () => {
    const body = passwordChangedBody({ ...english, name: HOSTILE });

    expect(body).not.toMatch(/https?:/i);
    expect(body).not.toContain('evil.test');
    expect(body).not.toContain('/fix');
  });

  it('cannot add a line to the subject, where a newline is header injection', () => {
    expect(passwordChangedSubject({ ...english, name: HOSTILE })).not.toMatch(
      /[\r\n]/,
    );
  });

  /** Thai copy interpolates the same name, so it gets the same guarantee. */
  it('cannot add a line to the Thai body either', () => {
    const lines = passwordChangedBody({ ...thai, name: HOSTILE }).split('\n');

    expect(lines).toHaveLength(passwordChangedBody(thai).split('\n').length);
  });

  /**
   * A name that is nothing BUT a link leaves nothing to greet with. The mail is
   * already addressed to that person, so it drops the name rather than the
   * greeting — and certainly rather than the notice.
   */
  it('greets without a name when nothing usable survives', () => {
    const body = passwordChangedBody({
      ...english,
      name: 'https://evil.test/fix',
    });

    expect(body.split('\n')[0]).toBe('Hi,');
    expect(body).toMatch(/password was changed/i);
  });
});

/**
 * The lures that need no URL punctuation at all.
 *
 * The line count above is not the guarantee. `safeDisplayName` held the
 * newline, so the body is still the same number of lines — and a greeting
 * reading `Hi Support +66 81 234 5678,` is a TAPPABLE NUMBER on a phone,
 * because iOS Mail and Gmail on Android linkify a run of digits into `tel:`
 * without any scheme or dot to go on. `Hi Ignore this, it was me, your admin,`
 * needs no link at all: it is the attacker answering the warning, in Eventa's
 * voice, at the top of the mail that reports them.
 *
 * All three are reachable: the name is `UpdateProfileDto.name`, `@IsString()
 * @MaxLength(200)` with no charset rule, written through precisely the session
 * this notice reports.
 */
describe('a hostile name that carries no URL punctuation', () => {
  const LURES = [
    'Ignore this, it was me, your admin',
    'Somchai call 0812345678 now',
    'Support +66 81 234 5678',
  ];

  it.each(LURES)('greets without a name rather than print %p', (name) => {
    const body = passwordChangedBody({ ...english, name });

    expect(body.split('\n')[0]).toBe('Hi,');
    expect(body).toMatch(/password was changed/i);
  });

  it.each(LURES)('keeps %p out of the mail entirely', (name) => {
    expect(passwordChangedBody({ ...english, name })).not.toContain(name);
    expect(passwordChangedSubject({ ...english, name })).not.toContain(name);
  });

  /**
   * On the greeting line only: the body prints a timestamp and a sign-in count,
   * and those digits are Eventa's own.
   */
  it.each(LURES)('leaves no digit a phone could dial, from %p', (name) => {
    const greeting = passwordChangedBody({ ...english, name }).split('\n')[0];

    expect(greeting).not.toMatch(/\d/u);
  });

  /** Thai copy interpolates the same name, so it gets the same guarantee. */
  it.each(LURES)(
    'greets a Thai reader without a name either, for %p',
    (name) => {
      const body = passwordChangedBody({ ...thai, name });

      expect(body.split('\n')[0]).toBe('สวัสดี');
      expect(body).not.toContain(name);
    },
  );
});
