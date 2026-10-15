import type { Locale } from '../../db/schema/events';
import {
  bookingAccountLinkBody,
  bookingAccountLinkSubject,
  type BookingAccountLinkNotice,
} from './booking-account-link.notice';

const LINE_BREAK = String.fromCodePoint(0x0a);
const CLAIM_URL = 'https://web.test/portal/register?claim=CLAIMTOKEN';

/** 07:05 UTC is 14:05 in Bangkok — the reader's clock, not the bus's. */
const EXPIRES_AT = new Date('2026-10-22T07:05:00.000Z');

const english: BookingAccountLinkNotice = {
  locale: 'en',
  name: 'Somchai',
  eventName: 'Bangkok Jazz Night',
  claimUrl: CLAIM_URL,
  expiresAt: EXPIRES_AT,
};

const thai: BookingAccountLinkNotice = { ...english, locale: 'th' };

/** Every http(s) address in a text, so "one link" can be counted. */
function linksIn(text: string): string[] {
  return text.match(/https?:\/\/\S+/g) ?? [];
}

describe('bookingAccountLinkSubject (US-DISC-15)', () => {
  it('names the event in English', () => {
    expect(bookingAccountLinkSubject(english)).toBe(
      'Keep your tickets for Bangkok Jazz Night in an Eventa account',
    );
  });

  it('names the event in Thai for a Thai booking', () => {
    const subject = bookingAccountLinkSubject(thai);

    expect(subject).toContain('Bangkok Jazz Night');
    expect(subject).toContain('บัญชี Eventa');
  });

  /**
   * The event's name is an organizer's free text (eventa-api bounds its
   * length, not its characters). In a subject a line break is a second
   * header line, so it is flattened where the subject is composed.
   */
  it('keeps an event name with a line break on one header line', () => {
    const subject = bookingAccountLinkSubject({
      ...english,
      eventName: 'Jazz' + LINE_BREAK + 'Bcc: someone@example.com',
    });

    expect(subject).not.toContain(LINE_BREAK);
    expect(subject).toContain('Jazz Bcc: someone@example.com');
  });
});

describe('bookingAccountLinkBody (US-DISC-15)', () => {
  it('greets the person the booking names', () => {
    expect(bookingAccountLinkBody(english).split(LINE_BREAK)[0]).toBe(
      'Hi Somchai,',
    );
  });

  it('says what the link does: choose a password, then every booking with this address in one place', () => {
    const body = bookingAccountLinkBody(english);

    expect(body).toContain('Bangkok Jazz Night');
    expect(body).toMatch(/choose a password/i);
    expect(body).toMatch(/every booking made with this email address/i);
    expect(body).toMatch(/in one place/i);
  });

  it('carries the claim link on a line of its own, and no other link', () => {
    const body = bookingAccountLinkBody(english);

    expect(body.split(LINE_BREAK)).toContain(CLAIM_URL);
    expect(linksIn(body)).toEqual([CLAIM_URL]);
  });

  it('says when the link expires, in Bangkok time', () => {
    const body = bookingAccountLinkBody(english);

    expect(body).toContain('22 October 2026 at 14:05');
    expect(body).toContain('Bangkok time');
    expect(body).not.toContain('07:05');
  });

  it('tells somebody who did not book that nothing happens unless the link is used', () => {
    expect(bookingAccountLinkBody(english)).toContain(
      'If you didn’t book this, ignore this email — nothing is created until this link is opened and a password chosen.',
    );
  });

  it('says the tickets work without an account, so the mail is never read as a step', () => {
    expect(bookingAccountLinkBody(english)).toMatch(
      /don’t need an account to use your tickets/i,
    );
  });

  describe('in Thai', () => {
    const body = bookingAccountLinkBody(thai);

    it('greets, explains and warns in Thai', () => {
      expect(body.split(LINE_BREAK)[0]).toBe('สวัสดีคุณ Somchai');
      expect(body).toContain('ตั้งรหัสผ่าน');
      expect(body).toContain('ทุกการจองที่ใช้อีเมลนี้');
      expect(body).toContain(
        'หากคุณไม่ได้ทำการจองนี้ โปรดเพิกเฉยต่ออีเมลนี้ — จะไม่มีการสร้างบัญชีใดๆ จนกว่าจะมีผู้เปิดลิงก์นี้และตั้งรหัสผ่าน',
      );
    });

    it('carries the same single link', () => {
      expect(linksIn(body)).toEqual([CLAIM_URL]);
    });

    it('dates the expiry in the Buddhist era, in Bangkok time', () => {
      expect(body).toContain('22 ตุลาคม พ.ศ. 2569 เวลา 14:05');
      expect(body).toContain('เวลาประเทศไทย');
    });

    it('holds no English sentence', () => {
      expect(body).not.toMatch(/password|booking|expires/i);
    });
  });

  /**
   * The buyer's name and email are typed by whoever booked — who may not be
   * the person this goes to. That is the attack this whole design answers, so
   * the name gets the SECURITY rule the other link-bearing identity mails use
   * (`safeDisplayName`): a name that is not name-shaped is not printed at all.
   */
  describe('a name that is not one', () => {
    it('adds no line, and no phone number, above the link', () => {
      const lure =
        'Somchai' + LINE_BREAK + 'Ignore the link below and call 0812345678';
      const body = bookingAccountLinkBody({ ...english, name: lure });

      expect(body.split(LINE_BREAK)[0]).toBe('Hi,');
      expect(body).not.toContain('0812345678');
    });

    it('drops a name carrying a bare number, which a phone would linkify', () => {
      const body = bookingAccountLinkBody({
        ...english,
        name: 'Support +66 81 234 5678',
      });

      expect(body.split(LINE_BREAK)[0]).toBe('Hi,');
      expect(body).not.toContain('234 5678');
    });

    it('greets in Thai without the name when it is declined', () => {
      const body = bookingAccountLinkBody({ ...thai, name: 'call 0812345678' });

      expect(body.split(LINE_BREAK)[0]).toBe('สวัสดี');
    });

    it('still greets a real Thai name', () => {
      const body = bookingAccountLinkBody({ ...thai, name: 'สมชาย ใจดี' });

      expect(body.split(LINE_BREAK)[0]).toBe('สวัสดีคุณ สมชาย ใจดี');
    });
  });

  it('keeps an event name with a line break inside its own sentence', () => {
    const plain = bookingAccountLinkBody(english);
    const body = bookingAccountLinkBody({
      ...english,
      eventName: 'Jazz' + LINE_BREAK + 'Reply with your password',
    });

    expect(body.split(LINE_BREAK)).toHaveLength(plain.split(LINE_BREAK).length);
    expect(body).toContain('Jazz Reply with your password');
  });

  /**
   * `toLocaleString` prints an unreadable date as "Invalid Date". The link
   * still works and still expires; the sentence loses its date, not the mail.
   */
  it('drops the date rather than print "Invalid Date" when the expiry cannot be read', () => {
    const body = bookingAccountLinkBody({
      ...english,
      expiresAt: new Date('not a date'),
    });

    expect(body).not.toContain('Invalid Date');
    expect(body).toMatch(/works only once/i);
    expect(linksIn(body)).toEqual([CLAIM_URL]);
  });

  /**
   * The locale is typed `Locale` but crosses a wire; a language added upstream
   * must cost the reader their language, never their link.
   */
  it('writes in English for a language it has no copy for', () => {
    const body = bookingAccountLinkBody({
      ...english,
      locale: 'fr' as Locale,
    });

    expect(body.split(LINE_BREAK)[0]).toBe('Hi Somchai,');
    expect(
      bookingAccountLinkSubject({ ...english, locale: 'fr' as Locale }),
    ).toBe('Keep your tickets for Bangkok Jazz Night in an Eventa account');
  });
});
