import type { Locale } from '../../db/schema/events';
import { phoneVerificationSms } from './phone-verification-sms';

/** 07:05 UTC is 14:05 in Bangkok, which has no daylight saving. */
const EXPIRES_AT = new Date('2026-10-15T07:05:00.000Z');

/** One segment of GSM-7: what an English text must stay inside. */
const GSM7_SEGMENT = 160;

describe('phoneVerificationSms (US-DISC-11 AC3)', () => {
  it('carries the code and when it stops working, in Bangkok time', () => {
    const text = phoneVerificationSms({
      locale: 'en',
      code: '042917',
      expiresAt: EXPIRES_AT,
    });
    expect(text).toContain('042917');
    expect(text).toContain('14:05');
    expect(text).toMatch(/Bangkok/);
  });

  it('writes to a Thai reader in Thai', () => {
    const text = phoneVerificationSms({
      locale: 'th',
      code: '042917',
      expiresAt: EXPIRES_AT,
    });
    expect(text).toContain('042917');
    expect(text).toContain('14:05');
    expect(text).toContain('รหัส');
  });

  it('keeps the English text to one plain GSM-7 segment', () => {
    // One typographic character moves the whole text to UCS-2, at 70
    // characters a segment instead of 160.
    const text = phoneVerificationSms({
      locale: 'en',
      code: '042917',
      expiresAt: EXPIRES_AT,
    });
    expect(text).toMatch(/^[A-Za-z0-9 .,:()'-]+$/);
    expect(text.length).toBeLessThanOrEqual(GSM7_SEGMENT);
  });

  it('still sends the code when the expiry cannot be read', () => {
    // An unreadable date must not cost somebody their code, nor print
    // "Invalid Date" at them.
    const text = phoneVerificationSms({
      locale: 'en',
      code: '042917',
      expiresAt: new Date('not a date'),
    });
    expect(text).toContain('042917');
    expect(text).not.toMatch(/invalid/i);
  });

  it('falls back to English for a language it has not heard of', () => {
    const text = phoneVerificationSms({
      locale: 'ja' as Locale,
      code: '042917',
      expiresAt: EXPIRES_AT,
    });
    expect(text).toContain('042917');
    expect(text).toMatch(/code/);
  });
});
