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
