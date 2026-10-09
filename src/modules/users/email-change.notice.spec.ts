import {
  emailChangeConfirmationBody,
  emailChangeConfirmationSubject,
  emailChangeHeadsUpBody,
  emailChangeHeadsUpSubject,
  type EmailChangeConfirmation,
  type EmailChangeHeadsUp,
} from './email-change.notice';

const CONFIRM_URL = 'https://web.test/confirm-email?token=CTOKEN';

/** 07:05 UTC is 14:05 in Bangkok — the whole point of rendering in +07. */
const OCCURRED_AT = new Date('2026-10-09T07:05:00.000Z');

const englishConfirmation: EmailChangeConfirmation = {
  name: 'Somchai',
  locale: 'en',
  confirmUrl: CONFIRM_URL,
};

const thaiConfirmation: EmailChangeConfirmation = {
  ...englishConfirmation,
  locale: 'th',
};

/**
 * A name an attacker chose. `UpdateProfileDto` in eventa-api is `@IsString()`
 * `@MaxLength(200)` — no charset and no newline restriction — and the session
 * that sets it is the stolen one this whole flow exists to resist. These are
 * plain-text mails that most clients auto-linkify, so a newline plus a URL puts
 * an attacker-chosen destination above the warning.
 */
const INJECTING_NAME =
  'Somchai\n\nURGENT: secure your account now at https://eventa-help.evil.test/fix';

/** The same thing in a subject would be header injection, not just a line. */
const NEWLINES = /[\r\n]/;

/**
 * U+2028 LINE SEPARATOR — a break many renderers honour and `[\r\n]` misses, so
 * the sanitiser has to work off whitespace and control classes, not two
 * characters.
 */
const UNICODE_LINE_SEPARATOR = String.fromCharCode(0x2028);

const englishHeadsUp: EmailChangeHeadsUp = {
  locale: 'en',
  requestedEmail: 'new-address@acme.co.th',
  occurredAt: OCCURRED_AT,
};

const thaiHeadsUp: EmailChangeHeadsUp = { ...englishHeadsUp, locale: 'th' };

describe('emailChangeConfirmationSubject', () => {
  it('asks for a confirmation in English', () => {
    expect(emailChangeConfirmationSubject(englishConfirmation)).toMatch(
      /confirm/i,
    );
  });

  it('asks for a confirmation in Thai for a Thai reader', () => {
    expect(emailChangeConfirmationSubject(thaiConfirmation)).toContain(
      'ยืนยัน',
    );
  });
});

describe('emailChangeConfirmationBody', () => {
  it('greets the reader and carries the link', () => {
    const body = emailChangeConfirmationBody(englishConfirmation);

    expect(body).toContain('Somchai');
    expect(body).toContain(CONFIRM_URL);
  });

  /**
   * Nothing is lost until the link is opened, and a reader who is about to be
   * told "confirm this" deserves to know their old address still signs them in.
   */
  it('says the link is single-use, time-limited, and that the current address still works', () => {
    const body = emailChangeConfirmationBody(englishConfirmation);

    expect(body).toMatch(/24 hours/);
    expect(body).toMatch(/once/i);
    expect(body).toMatch(/current email/i);
  });

  /** The requested address may belong to a stranger typed in by mistake. */
  it('tells a reader who did not ask for this that they can ignore it', () => {
    expect(emailChangeConfirmationBody(englishConfirmation)).toMatch(/ignore/i);
  });

  /**
   * A Thai reader must get the link AND the conditions around it — a Thai
   * email with an English "expires in 24 hours" line is half-translated.
   */
  it('writes the whole confirmation in Thai for a Thai reader, link included', () => {
    const body = emailChangeConfirmationBody(thaiConfirmation);

    expect(body).toContain(CONFIRM_URL);
    expect(body).toContain('ยืนยัน');
    expect(body).toContain('24 ชั่วโมง');
    expect(body).not.toMatch(/sign in to Eventa/i);
  });
});

describe('emailChangeHeadsUpSubject', () => {
  it('names the change in English', () => {
    expect(emailChangeHeadsUpSubject(englishHeadsUp)).toMatch(/email address/i);
  });

  it('names the change in Thai for a Thai reader', () => {
    expect(emailChangeHeadsUpSubject(thaiHeadsUp)).toContain('อีเมล');
  });
});

describe('emailChangeHeadsUpBody', () => {
  /**
   * THE security property of this message. A heads-up that trains people to
   * click a link in a security alert is the phishing lure it warns about, and
   * the confirmation token must never reach the address a takeover is moving
   * the account AWAY from — mailing it there hands the victim the button that
   * completes their own takeover.
   */
  it('carries no link of any kind', () => {
    for (const body of [
      emailChangeHeadsUpBody(englishHeadsUp),
      emailChangeHeadsUpBody(thaiHeadsUp),
    ]) {
      expect(body).not.toContain(CONFIRM_URL);
      expect(body).not.toContain('CTOKEN');
      expect(body).not.toMatch(/https?:/i);
      expect(body).not.toContain('://');
    }
  });

  /**
   * The heads-up is NOT personalised, and that is the point: see the fixture
   * above and the file docstring. It still opens with a greeting so it reads as
   * a message rather than an alarm, and the greeting prints nothing an attacker
   * supplied.
   */
  it('greets the reader without a name and says a change was requested', () => {
    const body = emailChangeHeadsUpBody(englishHeadsUp);

    expect(body.split('\n')[0]).toBe('Hello,');
    expect(body).toMatch(/request was made/i);
  });

  /**
   * The one fact that makes this message actionable: WHERE the account is being
   * moved to. See the file docstring for why it is disclosed in full.
   */
  it('names the requested address', () => {
    expect(emailChangeHeadsUpBody(englishHeadsUp)).toContain(
      'new-address@acme.co.th',
    );
    expect(emailChangeHeadsUpBody(thaiHeadsUp)).toContain(
      'new-address@acme.co.th',
    );
  });

  /**
   * The reader has not lost anything yet, and saying so is what turns alarm
   * into an action they can still take in time.
   */
  it('says the change has NOT happened yet and this address still signs them in', () => {
    const body = emailChangeHeadsUpBody(englishHeadsUp);

    expect(body).toMatch(/not yet/i);
    expect(body).toMatch(/still sign in/i);
  });

  /**
   * The timestamp crosses the bus in UTC and is read by someone in Thailand.
   * Rendering it raw would have the alert contradict the clock on the wall of
   * the person deciding whether this was them.
   */
  it('renders the time in Asia/Bangkok, not UTC', () => {
    const body = emailChangeHeadsUpBody(englishHeadsUp);

    expect(body).toContain('14:05');
    expect(body).not.toContain('07:05');
  });

  /** A Thai reader expects the Buddhist era, which `th-TH` supplies. */
  it('renders the time in Thai, Buddhist era, for a Thai reader', () => {
    const body = emailChangeHeadsUpBody(thaiHeadsUp);

    expect(body).toContain('2569');
    expect(body).toContain('14:05');
  });

  it('says which timezone the time is in, so it is not read as local', () => {
    expect(emailChangeHeadsUpBody(englishHeadsUp)).toMatch(/bangkok/i);
  });

  /**
   * The alert matters most when the reader did NOT do this, so it has to say
   * what to do about it — all of which happens behind a sign-in, not a link.
   */
  it('tells a reader who did not do this what to do', () => {
    const body = emailChangeHeadsUpBody(englishHeadsUp);

    expect(body).toMatch(/password/i);
    expect(body).toMatch(/sign(ed)? out/i);
  });

  it('tells a Thai reader who did not do this what to do', () => {
    expect(emailChangeHeadsUpBody(thaiHeadsUp)).toContain('รหัสผ่าน');
  });

  /**
   * A timestamp this service cannot read must not cost the person their
   * warning — the same "omit rather than render blank" rule the two-factor and
   * cancellation notices follow.
   */
  it('omits the time line rather than failing when the timestamp is unreadable', () => {
    const body = emailChangeHeadsUpBody({
      ...englishHeadsUp,
      occurredAt: new Date('not-a-date'),
    });

    expect(body).toMatch(/request was made/i);
    expect(body).not.toMatch(/invalid date/i);
    expect(body).not.toMatch(/\bnan\b/i);
  });

  /**
   * The heads-up takes no name at all, so there is no field to inject through —
   * the strongest form of this fix, and the reason this suite can only assert
   * the absence. The end-to-end property, that the name on the EVENT reaches
   * neither mail as a line of its own, is pinned in `email-change.handler.spec`.
   */
  it('is not personalised in either language', () => {
    expect(emailChangeHeadsUpBody(englishHeadsUp)).not.toContain('Somchai');
    expect(emailChangeHeadsUpBody(thaiHeadsUp)).not.toContain('Somchai');
    expect(emailChangeHeadsUpBody(thaiHeadsUp).split('\n')[0]).toBe('สวัสดี');
  });
});

/**
 * NAME INJECTION. The name is the one piece of free text on this event, it is
 * written by the stolen session this flow resists, and these are plain-text
 * mails whose clients linkify what looks like a link.
 */
describe('a name an attacker supplied', () => {
  const injected = emailChangeConfirmationBody({
    ...englishConfirmation,
    name: INJECTING_NAME,
  });

  /** A line of their own, above the real copy, is the whole attack. */
  it('adds no line of its own to the confirmation', () => {
    expect(injected.split('\n')).toHaveLength(
      emailChangeConfirmationBody(englishConfirmation).split('\n').length,
    );
    expect(injected).not.toMatch(/^URGENT/m);
  });

  /** Exactly one line may carry a scheme, and it must be Eventa's own link. */
  it('leaves only the real link linkifiable', () => {
    expect(injected.split('\n').filter((l) => l.includes('://'))).toEqual([
      CONFIRM_URL,
    ]);
    expect(injected).not.toContain('evil.test');
  });

  /**
   * Collapsing the newlines is only the floor: on one line, `Hi Somchai …
   * https://evil.test/fix,` is still a destination most clients linkify.
   *
   * This test used to assert that the greeting KEPT `Somchai` and dropped the
   * link-shaped runs around it — and that is the behaviour the fix removed, not
   * a detail of it. Dropping the bad run and greeting with the remainder is
   * what edited this very string into `Hi Somchai secure your account at,`: a
   * sentence fragment the attacker chose, printed as somebody's name. A name is
   * now accepted or declined whole, and a declined one falls back to the
   * greeting this mail already had for a reader it cannot name.
   */
  it('declines the whole name rather than greeting with the rest of it', () => {
    const greeting = injected.split('\n')[0];

    expect(greeting).toBe('Hello,');
    expect(greeting).not.toMatch(NEWLINES);
  });

  /** Two characters are not the whole alphabet of a line break. */
  it('collapses a Unicode line separator too, not just CR and LF', () => {
    const body = emailChangeConfirmationBody({
      ...englishConfirmation,
      name: `Somchai${UNICODE_LINE_SEPARATOR}https://evil.test`,
    });

    expect(body.split('\n')[0]).not.toContain(UNICODE_LINE_SEPARATOR);
    expect(body.split('\n')[0]).not.toContain('://');
  });

  /** A newline in a subject is header injection, not just an ugly line. */
  it('cannot reach either subject', () => {
    expect(
      emailChangeConfirmationSubject({
        ...englishConfirmation,
        name: INJECTING_NAME,
      }),
    ).not.toMatch(NEWLINES);
    expect(emailChangeHeadsUpSubject(englishHeadsUp)).not.toMatch(NEWLINES);
  });

  /** 200 characters of profile name is 200 characters of forged sentence. */
  it('caps how much of a name a greeting prints', () => {
    const body = emailChangeConfirmationBody({
      ...englishConfirmation,
      name: 'ก'.repeat(200),
    });

    expect(body.split('\n')[0].length).toBeLessThan(80);
  });

  /** With nothing printable left, the greeting drops the name rather than the mail. */
  it('greets without a name when nothing printable survives', () => {
    const body = emailChangeConfirmationBody({
      ...englishConfirmation,
      name: '://',
    });

    expect(body.split('\n')[0]).toBe('Hello,');
    expect(body).toContain(CONFIRM_URL);
  });

  /** And none of this may cost an ordinary reader their own name. */
  it('leaves an ordinary Thai or English name exactly as written', () => {
    for (const name of ['สมชาย ใจดี', "Siobhán O'Brien-Lee"]) {
      expect(
        emailChangeConfirmationBody({ ...englishConfirmation, name }),
      ).toContain(name);
    }
  });
});

/**
 * The same attack with no URL punctuation in it. The confirmation already
 * carries Eventa's own link, so the harm here is not a second one: it is the
 * line `Hi Support +66 81 234 5678,` printed above it, a number a phone turns
 * into `tel:` and a reader reads as the help desk. A name that is not
 * name-shaped is declined whole — see `common/messaging/display-name.ts`.
 */
describe('a hostile name that carries no URL punctuation', () => {
  const LURES = [
    'Ignore this, it was me, your admin',
    'Somchai call 0812345678 now',
    'Support +66 81 234 5678',
  ];

  it.each(LURES)('greets without a name rather than print %p', (name) => {
    const body = emailChangeConfirmationBody({ ...englishConfirmation, name });

    expect(body.split('\n')[0]).toBe('Hello,');
    expect(body).not.toContain(name);
    expect(body.split('\n')[0]).not.toMatch(/\d/u);
    expect(body).toContain(CONFIRM_URL);
  });

  it.each(LURES)('greets a Thai reader without one either, for %p', (name) => {
    const body = emailChangeConfirmationBody({ ...thaiConfirmation, name });

    expect(body.split('\n')[0]).toBe('สวัสดี');
    expect(body).not.toContain(name);
  });
});
