import { safeDisplayName } from '../../common/messaging/display-name';
import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import type { Locale } from '../../db/schema/events';

/**
 * The "two-factor was turned off" security alert, in English and Thai
 * (US-SET-03).
 *
 * This is identity mail: it goes to the account holder about their own account,
 * so it is UNCONDITIONAL and consults no template catalog. An organizer may
 * switch off the workspace's attendee templates; they may not switch off
 * somebody's security correspondence, because the person whose second factor
 * was removed by an intruder is precisely the person an organizer's template
 * setting must not be able to silence.
 *
 * The alert matters most when the reader did NOT do this, which decides the
 * shape of the copy: it reports the change, stamps WHEN it happened so the
 * reader can match it against what they remember doing, and then says what to
 * do if it was not them. It deliberately contains no link. Everything a
 * compromised account needs — a new password, a new second factor — happens
 * behind a sign-in, and a security alert that trains people to click a link in
 * a security alert is the phishing lure it was meant to warn them about.
 *
 * What it does NOT say is the device and IP address, although the sign-in
 * notice genre usually carries them: `identity.two_factor_disabled` does not
 * carry either field (see eventa-api's
 * `auth-two-factor/events/two-factor-disabled.event.ts`), and inventing a
 * "unknown device" line would be worse than silence on a security alert.
 *
 * THE "NO LINK" CLAIM IS ENFORCED, NOT MERELY INTENDED. The reader's name is
 * the one piece of free text here, and the session that can set it is the
 * stolen one this alert reports — so it goes through `safeDisplayName` before
 * it is greeted with, and the greeting drops it entirely rather than print
 * something link-shaped. Without that, a profile renamed to
 * "Somchai\n\nURGENT: … https://evil.test/fix" would put an attacker's line,
 * and an attacker's clickable host, above Eventa's own warning.
 */

/**
 * Security alerts are stamped in Thailand's time, whatever the reader's own
 * clock says — the same rule receipts follow. The timestamp crosses the bus in
 * UTC; this is the only place it becomes a wall clock.
 */
const NOTICE_TIMEZONE = 'Asia/Bangkok';

/** BCP-47 tag per locale; `th-TH` also gives a Thai reader the Buddhist era. */
const BCP47: Record<Locale, string> = { en: 'en-GB', th: 'th-TH' };

export interface TwoFactorDisabledNotice {
  /**
   * The account holder, as their user record names them — free text written
   * through the API, so never rendered without {@link safeDisplayName}.
   */
  name: string;
  locale: Locale;
  /** When the API recorded the change. UTC on the wire, Bangkok on screen. */
  occurredAt: Date;
}

/**
 * One language's strings. Declared so EN and TH must stay the same shape.
 *
 * `greeting` takes `string | null` because a name may be entirely unprintable
 * once it has been through {@link safeDisplayName} — the mail is addressed to
 * one mailbox and loses very little by not naming its reader, where the warning
 * would lose everything by not being sent.
 */
interface Copy {
  subject: string;
  greeting: (name: string | null) => string;
  disabled: string;
  when: (whenText: string) => string;
  wasYou: string;
  wasNotYou: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: 'Two-factor authentication was turned off',
    greeting: (name) => (name ? `Hi ${name},` : 'Hi,'),
    disabled:
      'Two-factor authentication was turned off for your Eventa account.',
    when: (whenText) => `When: ${whenText} (Bangkok time)`,
    wasYou: 'If you did this, there is nothing else to do.',
    wasNotYou:
      'If you did not do this, somebody else may have access to your account. Change your password now, then turn two-factor authentication back on in your account settings.',
  },
  th: {
    subject: 'การยืนยันตัวตนสองขั้นถูกปิดใช้งาน',
    greeting: (name) => (name ? `สวัสดีคุณ ${name}` : 'สวัสดี'),
    disabled: 'การยืนยันตัวตนสองขั้นของบัญชี Eventa ของคุณถูกปิดใช้งานแล้ว',
    when: (whenText) => `เวลา: ${whenText} (เวลาประเทศไทย)`,
    wasYou: 'หากคุณดำเนินการนี้ด้วยตนเอง ไม่ต้องดำเนินการอะไรเพิ่มเติม',
    wasNotYou:
      'หากคุณไม่ได้ดำเนินการนี้ อาจมีผู้อื่นเข้าถึงบัญชีของคุณได้ กรุณาเปลี่ยนรหัสผ่านทันที แล้วเปิดใช้งานการยืนยันตัวตนสองขั้นอีกครั้งในการตั้งค่าบัญชีของคุณ',
  },
};

/**
 * The copy for a locale, falling back rather than returning `undefined`.
 *
 * `COPY` is a `Record<Locale, Copy>` and `notice.locale` is typed `Locale`, so
 * indexing it looks total — and is not. This service only MIRRORS eventa-api's
 * `locale` pgEnum and Drizzle maps no enum values on the way in, so a language
 * added upstream arrives as a string this table has no key for. Indexing it
 * then threw a `TypeError` while building the subject, BEFORE the send and
 * without the warn line or counter a failed READ would have produced: the
 * alert rode the retry ladder into the dead-letter queue in silence.
 *
 * `common/messaging/locale.ts` coerces the value where it enters from the
 * database, which fixes the path that actually broke. This is the second
 * guard, here because this file is what indexes the table: no caller, present
 * or future, should be able to turn a language it has not heard of into a
 * person not hearing about their own account.
 */
function copyFor(locale: Locale): Copy {
  return COPY[locale] ?? COPY[DEFAULT_LOCALE];
}

export function twoFactorDisabledSubject(
  notice: TwoFactorDisabledNotice,
): string {
  return copyFor(notice.locale).subject;
}

export function twoFactorDisabledBody(notice: TwoFactorDisabledNotice): string {
  const t = copyFor(notice.locale);
  return [
    t.greeting(safeDisplayName(notice.name)),
    '',
    t.disabled,
    ...whenLine(notice, t),
    '',
    t.wasYou,
    '',
    t.wasNotYou,
  ].join('\n');
}

/**
 * The time, or nothing at all.
 *
 * A timestamp this service cannot parse must not cost somebody their security
 * alert, so an unreadable date drops the line rather than throwing or printing
 * "Invalid Date" — the same "omit rather than render blank" rule the
 * cancellation and confirmation notices follow. The rest of the warning is
 * still true and still worth sending.
 */
function whenLine(notice: TwoFactorDisabledNotice, t: Copy): string[] {
  if (Number.isNaN(notice.occurredAt.getTime())) return [];
  return ['', t.when(formatOccurredAt(notice.occurredAt, notice.locale))];
}

function formatOccurredAt(occurredAt: Date, locale: Locale): string {
  return occurredAt.toLocaleString(BCP47[locale], {
    timeZone: NOTICE_TIMEZONE,
    dateStyle: 'long',
    timeStyle: 'short',
  });
}
