import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import type { Locale } from '../../db/schema/events';
import { BCP47, NOTICE_TIMEZONE } from '../../common/constants/users.constants';

/**
 * The text that carries the code confirming a new phone number (US-DISC-11
 * AC3): "I must confirm it by code before it's used for texts".
 *
 * The code and when it stops working, and nothing else — no name, which is
 * free text the requester wrote, and no link. Eventa's own words, in English
 * and Thai.
 */

/** One language's text. Declared so EN and TH must stay the same shape. */
interface SmsCopy {
  code: (code: string) => string;
  expires: (time: string) => string;
}

/**
 * The English copy is PURE GSM-7 and one segment: a single typographic
 * character would move it to UCS-2, at 70 characters a segment instead of 160.
 */
const COPY: Record<Locale, SmsCopy> = {
  en: {
    code: (code) =>
      `Eventa: ${code} is your code to confirm this phone number. Do not share it.`,
    expires: (time) => `It expires at ${time} Bangkok time.`,
  },
  th: {
    code: (code) =>
      `Eventa: รหัสยืนยันเบอร์โทรศัพท์ของคุณคือ ${code} ห้ามบอกรหัสนี้แก่ผู้อื่น`,
    expires: (time) => `ใช้ได้ถึง ${time} น. (เวลาประเทศไทย)`,
  },
};

export interface PhoneVerificationSms {
  locale: Locale;
  code: string;
  expiresAt: Date;
}

export function phoneVerificationSms(details: PhoneVerificationSms): string {
  const locale = knownLocale(details.locale);
  const t = COPY[locale];
  return [
    t.code(details.code),
    ...expiryLine(details.expiresAt, locale, t),
  ].join(' ');
}

/**
 * The locale, or the default when this copy has no text for it. The value
 * comes from a mirrored enum, and a language added upstream must not cost
 * somebody their code — see `common/messaging/locale.ts`.
 */
function knownLocale(locale: Locale): Locale {
  return Object.hasOwn(COPY, locale) ? locale : DEFAULT_LOCALE;
}

/**
 * When the code stops working, or nothing at all: an expiry this service
 * cannot read drops the sentence rather than printing "Invalid Date".
 */
function expiryLine(expiresAt: Date, locale: Locale, t: SmsCopy): string[] {
  if (Number.isNaN(expiresAt.getTime())) return [];
  const time = expiresAt.toLocaleTimeString(BCP47[locale], {
    timeZone: NOTICE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return [t.expires(time)];
}
