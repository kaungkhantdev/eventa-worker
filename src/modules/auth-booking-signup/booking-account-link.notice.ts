import { safeDisplayName } from '../../common/messaging/display-name';
import { greeting } from '../../common/messaging/greeting';
import { inlineText } from '../../common/messaging/inline-text';
import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import type { Locale } from '../../db/schema/events';
import { formatWhen } from '../registration/confirmation-email';
import { NOTICE_TIMEZONE } from '../../common/constants/auth-booking-signup.constants';

/**
 * The mail that lets a guest turn a booking into an account (US-DISC-15), in
 * English and Thai.
 *
 * WHY IT IS A MAIL AND NOT A BUTTON ON THE CONFIRMATION SCREEN. The screen is
 * shown to whoever booked, and the booking's address is whatever they typed —
 * a free RSVP with somebody else's address is enough. An account made there
 * would let the booker choose that person's password and read every booking
 * ever made with their address. So the account only exists once this inbox
 * opens the link inside, and no password is chosen before then. The copy
 * follows from that:
 *
 * - **It says what the link does** — choose a password, then see every booking
 *   made with this address in one place — because that is what the reader is
 *   deciding about.
 * - **It says the tickets do not need it.** The account is an offer, never a
 *   step (US-DISC-15's note); a reader who ignores this keeps their tickets.
 * - **It ends on the safety line**, for the reader who did not book: nothing
 *   is created unless the link is opened and a password chosen.
 * - **One link, on its own line.** The mail is plain text, so the "button" is
 *   the address itself; one is all a reader should have to judge.
 *
 * Borrowed text gets the rule its owner warrants. The NAME was typed by
 * whoever booked, who may not be this reader — the same position as the name
 * on a sign-up verification mail — so it gets `safeDisplayName`, the
 * allow-list the link-bearing identity mails use, and a name that is not
 * name-shaped is not printed at all. The EVENT's name is an organizer's, as on
 * the ticket confirmation, so it is kept and only flattened onto its line with
 * `inlineText`. See `common/messaging/inline-text.ts` for why the two differ.
 */

export interface BookingAccountLinkNotice {
  locale: Locale;
  /** The buyer's name off the order — free text, typed by whoever booked. */
  name: string;
  /** The booked event's name — an organizer's free text. */
  eventName: string;
  /** The absolute link that claims the account. A credential: never logged. */
  claimUrl: string;
  /** When the link stops working. UTC on the wire, Bangkok on screen. */
  expiresAt: Date;
}

/** One language's strings. Declared so EN and TH must stay the same shape. */
interface Copy {
  subject: (event: string) => string;
  offer: (event: string) => string;
  expires: (when: string) => string;
  once: string;
  optional: string;
  notYou: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: (event) => `Keep your tickets for ${event} in an Eventa account`,
    offer: (event) =>
      `To keep your tickets for ${event} in an Eventa account, open this link and choose a password. You’ll then see every booking made with this email address in one place:`,
    expires: (when) =>
      `The link works only once and expires on ${when} (Bangkok time).`,
    once: 'The link works only once.',
    optional:
      'You don’t need an account to use your tickets — they are already in your confirmation email.',
    notYou:
      'If you didn’t book this, ignore this email — nothing is created until this link is opened and a password chosen.',
  },
  th: {
    subject: (event) => `เก็บบัตรงาน ${event} ไว้ในบัญชี Eventa`,
    offer: (event) =>
      `หากต้องการเก็บบัตรงาน ${event} ไว้ในบัญชี Eventa ให้เปิดลิงก์นี้แล้วตั้งรหัสผ่าน จากนั้นคุณจะเห็นทุกการจองที่ใช้อีเมลนี้ได้ในที่เดียว:`,
    expires: (when) =>
      `ลิงก์นี้ใช้ได้เพียงครั้งเดียว และจะหมดอายุเมื่อ${when} (เวลาประเทศไทย)`,
    once: 'ลิงก์นี้ใช้ได้เพียงครั้งเดียว',
    optional:
      'คุณใช้บัตรได้โดยไม่ต้องมีบัญชี บัตรของคุณอยู่ในอีเมลยืนยันการจองแล้ว',
    notYou:
      'หากคุณไม่ได้ทำการจองนี้ โปรดเพิกเฉยต่ออีเมลนี้ — จะไม่มีการสร้างบัญชีใดๆ จนกว่าจะมีผู้เปิดลิงก์นี้และตั้งรหัสผ่าน',
  },
};

/**
 * The locale, or the default when this copy has none for it: the value crossed
 * a wire, and a language added upstream must cost the reader their language,
 * never their link. See `common/messaging/locale.ts`.
 */
function knownLocale(locale: Locale): Locale {
  return Object.hasOwn(COPY, locale) ? locale : DEFAULT_LOCALE;
}

export function bookingAccountLinkSubject(
  notice: BookingAccountLinkNotice,
): string {
  const t = COPY[knownLocale(notice.locale)];
  return inlineText(t.subject(notice.eventName));
}

export function bookingAccountLinkBody(
  notice: BookingAccountLinkNotice,
): string {
  const locale = knownLocale(notice.locale);
  const t = COPY[locale];
  return [
    greeting(locale, safeDisplayName(notice.name) ?? ''),
    '',
    t.offer(inlineText(notice.eventName)),
    notice.claimUrl,
    '',
    expiryLine(notice.expiresAt, locale),
    t.optional,
    '',
    t.notYou,
  ].join('\n');
}

/**
 * When the link stops working, or just that it works once: an expiry this
 * service cannot read loses its date rather than printing "Invalid Date".
 */
function expiryLine(expiresAt: Date, locale: Locale): string {
  const t = COPY[locale];
  if (Number.isNaN(expiresAt.getTime())) return t.once;
  return t.expires(formatWhen(expiresAt, NOTICE_TIMEZONE, locale));
}
