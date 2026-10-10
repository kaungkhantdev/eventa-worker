import {
  type InvitationNotice,
  invitationBody,
  invitationSubject,
} from './invitation-email';

const WHEN_EN = 'Friday, 14 August 2026 at 09:00';

function notice(over: Partial<InvitationNotice> = {}): InvitationNotice {
  return {
    locale: 'en',
    name: 'Anan',
    eventName: 'Bangkok Tech Week',
    whenText: WHEN_EN,
    registerUrl: 'https://web.test/events/bangkok-tech-week',
    note: null,
    ...over,
  };
}

describe('the invitation email (US-REG-06)', () => {
  it('invites the reader, says when, and links into registration', () => {
    const text = invitationBody(notice());
    expect(text).toContain('Hi Anan,');
    expect(text).toContain('Bangkok Tech Week');
    expect(text).toContain(`When: ${WHEN_EN}`);
    expect(text).toContain('https://web.test/events/bangkok-tech-week');
    expect(invitationSubject(notice())).toBe(
      "You're invited to Bangkok Tech Week",
    );
  });

  it('puts the organizer’s personal note at the very top', () => {
    // US-REG-06 AC2 — "that note appears at the top of the invitation email".
    const text = invitationBody(
      notice({ note: 'Somchai asked me to pass this on — do come!' }),
    );
    expect(text.startsWith('Somchai asked me to pass this on — do come!')).toBe(
      true,
    );
    // The note heads the mail; it does not replace any of it.
    expect(text).toContain('Hi Anan,');
    expect(text).toContain('https://web.test/events/bangkok-tech-week');
  });

  it('says plainly that no seat is held until they register', () => {
    // The story's own note: an invite is a promise to attend, not a booking.
    expect(invitationBody(notice())).toMatch(/isn’t held until you register/);
  });

  it('greets without a name when nothing usable was left of it', () => {
    const text = invitationBody(notice({ name: null }));
    expect(text).toContain('Hello,');
    expect(text).not.toContain('Hi ');
    expect(text).toContain('https://web.test/events/bangkok-tech-week');
  });

  it('writes the whole thing in Thai for a Thai reader', () => {
    const text = invitationBody(
      notice({ locale: 'th', whenText: 'ศุกร์ 14 สิงหาคม 2569 09:00' }),
    );
    expect(text).toContain('สวัสดีคุณ Anan');
    expect(text).toContain('ลงทะเบียนที่นี่:');
    expect(text).not.toMatch(/Hi Anan|Register here|invited to/);
    expect(invitationSubject(notice({ locale: 'th' }))).toContain(
      'Bangkok Tech Week',
    );
  });

  it('lets the organizer reword the opening, never the link or the deadline', () => {
    const text = invitationBody(
      notice({ opening: 'We would love to see you in Bangkok.' }),
    );
    expect(text.startsWith('We would love to see you in Bangkok.')).toBe(true);
    expect(text).not.toContain('Hi Anan');
    expect(text).toContain(`When: ${WHEN_EN}`);
    expect(text).toContain('https://web.test/events/bangkok-tech-week');
  });

  /**
   * `InvitationNotice.opening` is documented as replacing "the greeting only",
   * and it replaced Eventa's own statement of what the mail IS along with it —
   * a docstring that claimed less than the code did, in the one direction that
   * matters. An organizer's wording is the second place their free text lands
   * (the name box is the first), so the sentence naming the event has to
   * survive it.
   */
  it('keeps Eventa’s own invitation sentence under the organizer’s opening', () => {
    const text = invitationBody(
      notice({ opening: 'We would love to see you in Bangkok.' }),
    );
    expect(text).toContain("You've been invited to Bangkok Tech Week.");
    expect(text.indexOf('We would love to see you')).toBeLessThan(
      text.indexOf("You've been invited to"),
    );
  });

  it('keeps it in Thai too, where the whole mail is Thai', () => {
    const text = invitationBody(
      notice({ locale: 'th', opening: 'ยินดีต้อนรับทุกท่าน' }),
    );
    expect(text).toContain('คุณได้รับเชิญให้เข้าร่วมงาน Bangkok Tech Week');
  });

  it('keeps the organizer’s note above their own reworded opening', () => {
    const text = invitationBody(
      notice({ note: 'A personal word', opening: 'Our own opening' }),
    );
    expect(text.indexOf('A personal word')).toBeLessThan(
      text.indexOf('Our own opening'),
    );
  });

  it('uses the organizer’s subject when they wrote one', () => {
    expect(invitationSubject(notice({ subject: 'Join us in Bangkok' }))).toBe(
      'Join us in Bangkok',
    );
  });
});

/**
 * The subject, where a second line is a second header.
 *
 * `invitationSubject` was the one dynamic subject builder of twelve that did
 * not flatten what it interpolates, while `reminderSubject` — the same line,
 * the same two sources — did. Both sources are reachable and neither is
 * charset-restricted: `events.name` is `@MinLength(3) @MaxLength(120)` and the
 * organizer's template subject is `@IsString() @MaxLength(200)`.
 *
 * Nodemailer happens to fold a CR/LF in a subject today, so this is not a
 * claim that mail is being injected right now. It is the reason `inline-text`
 * exists: there are three `EmailProvider` implementations, the guarantee must
 * not rest on one of them, and U+2028 is not folded by anybody.
 */
describe('a hostile value in the subject', () => {
  const LINE_BREAK = String.fromCodePoint(0x0a);
  const LINE_SEPARATOR = String.fromCodePoint(0x2028);

  it('cannot add a line through the event name', () => {
    const subject = invitationSubject(
      notice({
        eventName: 'Tech Week' + LINE_BREAK + 'Bcc: victim@evil.test',
      }),
    );

    expect(subject).not.toContain(LINE_BREAK);
    expect(subject.split(LINE_BREAK)).toHaveLength(1);
  });

  it('cannot add a line through the organizer’s own subject', () => {
    const subject = invitationSubject(
      notice({
        subject: 'Join us' + LINE_BREAK + 'Bcc: victim@evil.test',
      }),
    );

    expect(subject).not.toContain(LINE_BREAK);
  });

  /** Not folded by any provider, so the only defence is flattening it here. */
  it('cannot add a line with a separator a provider will not fold', () => {
    expect(
      invitationSubject(
        notice({ eventName: 'Tech Week' + LINE_SEPARATOR + 'x' }),
      ),
    ).not.toContain(LINE_SEPARATOR);
  });
});
