import { safeDisplayName } from '../../common/messaging/display-name';
import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import type { Locale } from '../../db/schema/events';

/**
 * The two messages one email change owes, in English and Thai (US-SET-01).
 *
 * They are written in one file because they are one flow and must not
 * contradict each other: the confirmation tells the REQUESTED address that
 * nothing has changed yet, and the heads-up tells the CURRENT one the same
 * thing. They also share the clock and the locale map below, which is one copy
 * per module rather than two.
 *
 * WHO GETS WHICH, AND WHY. The link goes only to the requested address; the
 * heads-up goes only to the current one and carries NO LINK AT ALL. The full
 * reasoning lives on {@link EmailChangeHandler}; the part that constrains the
 * copy here is that a security alert containing a link is the phishing lure it
 * was written to warn about, and that `confirmUrl` would hand the victim of a
 * takeover the button that completes it. Everything the heads-up asks for — a
 * new password, signing other sessions out — happens behind a sign-in the
 * reader starts themselves.
 *
 * ON NAMING THE REQUESTED ADDRESS IN THE HEADS-UP. It is disclosed in full,
 * which is a deliberate choice against a real argument the other way. Against:
 * if the address was mistyped it belongs to a third party, and printing it in
 * mail to the account holder discloses it. For, and decisive: this message has
 * exactly one reader who matters — somebody about to lose their account — and
 * the single most actionable fact for them, and for the support agent they
 * forward it to, is WHERE it is being moved to. "Someone asked to change your
 * email" with no destination leaves them able to report only that something
 * happened. The disclosure is also narrow in both directions that actually
 * occur: in the mistyped case the reader is the person who typed the address,
 * so they learn nothing they did not supply, and in the takeover case the
 * attacker chose it, so nothing is revealed to them either. The cost accepted
 * is the rarer shape — a stranger's address typed in by somebody who stole the
 * session, read later from a shared or breached mailbox — and that cost is
 * smaller than a warning the victim cannot act on.
 *
 * ON THE ACCOUNT HOLDER'S NAME — THE ONE PIECE OF FREE TEXT HERE. It arrives on
 * the event from eventa-api's `UpdateProfileDto`, which is `@IsString()`
 * `@MaxLength(200)` with no charset and no newline restriction, and the session
 * that writes it is the stolen one this flow exists to resist. In a plain-text
 * mail a newline in that name is a line of the attacker's own, above copy the
 * reader is meant to trust, and most clients linkify whatever looks like a URL
 * on it. Two different answers follow, because the two mails have different
 * readers:
 *
 * - The HEADS-UP prints no name at all. Sanitising fixes line structure, but the
 *   attacker still chooses the WORDS, and `Hi Eventa Security Team,` at the top
 *   of a takeover warning is a forgery no filter can catch. The reader is the
 *   account holder at their own address, so the name tells them nothing they do
 *   not know — it is pure attack surface in the one mail whose body promises it
 *   contains no links. {@link EmailChangeHeadsUp} therefore has no name field:
 *   there is nothing to inject through, rather than something filtered.
 * - The CONFIRMATION keeps a sanitised name, because its reader may be a
 *   stranger whose address was mistyped, and whose account this is about is
 *   exactly what lets them recognise it as not theirs and ignore it (which is
 *   what the copy asks them to do). `safeDisplayName` decides what survives —
 *   shared, because every identity notice faces the same wire field, and two
 *   copies of one security filter would be two things to keep in step. It
 *   accepts a name or nothing, so what reaches this greeting is name-shaped:
 *   no digits for a phone to turn into `tel:`, and not enough words to hold a
 *   sentence. The heads-up's bullet above is still the stronger answer, and
 *   `safeDisplayName`'s own docstring records why it cannot reach that far.
 *
 * Neither SUBJECT interpolates anything. That is deliberate and worth keeping:
 * a newline in a subject is header injection rather than one ugly line.
 */

/**
 * Security alerts are stamped in Thailand's time, whatever the reader's own
 * clock says — the same rule receipts and the two-factor alert follow. The
 * timestamp crosses the bus in UTC; this is the only place it becomes a wall
 * clock.
 */
const NOTICE_TIMEZONE = 'Asia/Bangkok';

/** BCP-47 tag per locale; `th-TH` also gives a Thai reader the Buddhist era. */
const BCP47: Record<Locale, string> = { en: 'en-GB', th: 'th-TH' };

/**
 * How long the confirmation link lives, as a number so each language can
 * phrase it.
 *
 * Named rather than inlined because it is duplicated knowledge: the lifetime is
 * the producer's `EMAIL_CHANGE_TTL_SECONDS` (24 hours) and it is not carried on
 * the payload, so if eventa-api ever shortens it this is the one place that
 * silently starts lying and the one place to correct.
 */
const LINK_LIFETIME_HOURS = 24;

/**
 * The greeting when no name is printed: the heads-up never prints one, and the
 * confirmation falls back to it rather than greeting `Hi ,` when
 * `safeDisplayName` finds nothing usable in a name. No politeness particle, the
 * same as every other Thai greeting in this service.
 */
const NAMELESS_GREETING: Record<Locale, string> = {
  en: 'Hello,',
  th: 'สวัสดี',
};

export interface EmailChangeConfirmation {
  /**
   * The account holder, as their user record names them — free text somebody
   * with the session wrote, printed only through {@link safeDisplayName}.
   */
  name: string;
  locale: Locale;
  /** The signed link that promotes the requested address. Bearer credential. */
  confirmUrl: string;
}

/**
 * Deliberately carries NO name: this mail is read by somebody who may be under
 * attack, and the name is the only string the attacker would control. See the
 * file docstring.
 */
export interface EmailChangeHeadsUp {
  locale: Locale;
  /** The address the change would move the account TO. */
  requestedEmail: string;
  /** When the API recorded the request. UTC on the wire, Bangkok on screen. */
  occurredAt: Date;
}

/** One language's confirmation strings. Declared so EN and TH stay in step. */
interface ConfirmationCopy {
  subject: string;
  greeting: (name: string) => string;
  confirm: string;
  expiry: (hours: number) => string;
  ignore: string;
}

/** One language's heads-up strings. Declared so EN and TH stay in step. */
interface HeadsUpCopy {
  subject: string;
  requested: (requestedEmail: string) => string;
  notYet: string;
  when: (whenText: string) => string;
  wasYou: string;
  wasNotYou: string;
}

const CONFIRMATION: Record<Locale, ConfirmationCopy> = {
  en: {
    subject: 'Confirm your new email address',
    greeting: (name) => `Hi ${name},`,
    confirm:
      'Confirm this address to make it the email you sign in to Eventa with:',
    expiry: (hours) =>
      `This link expires in ${hours} hours and can be used once. Until it is opened nothing changes — your current email address still signs you in.`,
    ignore:
      'If you didn’t ask to change your email, you can ignore this email: this address is not added to any Eventa account unless the link is opened.',
  },
  th: {
    subject: 'ยืนยันอีเมลใหม่ของคุณ',
    greeting: (name) => `สวัสดีคุณ ${name}`,
    confirm: 'ยืนยันอีเมลนี้ เพื่อใช้เป็นอีเมลสำหรับเข้าสู่ระบบ Eventa ของคุณ',
    expiry: (hours) =>
      `ลิงก์นี้จะหมดอายุใน ${hours} ชั่วโมง และใช้ได้เพียงครั้งเดียว จนกว่าจะมีการเปิดลิงก์ จะยังไม่มีการเปลี่ยนแปลงใด ๆ และคุณยังเข้าสู่ระบบด้วยอีเมลเดิมได้ตามปกติ`,
    ignore:
      'หากคุณไม่ได้ขอเปลี่ยนอีเมล คุณสามารถเพิกเฉยต่ออีเมลนี้ได้ อีเมลนี้จะไม่ถูกเพิ่มเข้าบัญชี Eventa ใดเลย หากไม่มีการเปิดลิงก์',
  },
};

const HEADS_UP: Record<Locale, HeadsUpCopy> = {
  en: {
    subject: 'Someone asked to change the email address on your account',
    requested: (requestedEmail) =>
      `A request was made to change the email address on your Eventa account to ${requestedEmail}.`,
    notYet:
      'This has not yet happened. You still sign in with this address, and it only changes when the confirmation link we sent to that other address is opened.',
    when: (whenText) => `Requested: ${whenText} (Bangkok time)`,
    wasYou:
      'If this was you, open the confirmation message at your new address and there is nothing else to do.',
    wasNotYou:
      'If this was not you, somebody else has access to your account. Change your password now and sign out of every other session from your account settings — do not use any link in this email to do it, because this email deliberately contains none. If the address above is not yours, contact Eventa support.',
  },
  th: {
    subject: 'มีการขอเปลี่ยนอีเมลของบัญชีคุณ',
    requested: (requestedEmail) =>
      `มีการขอเปลี่ยนอีเมลของบัญชี Eventa ของคุณเป็น ${requestedEmail}`,
    notYet:
      'การเปลี่ยนแปลงนี้ยังไม่เกิดขึ้น คุณยังเข้าสู่ระบบด้วยอีเมลนี้ได้ตามปกติ และจะเปลี่ยนเมื่อมีการเปิดลิงก์ยืนยันที่เราส่งไปยังอีเมลใหม่นั้นแล้วเท่านั้น',
    when: (whenText) => `เวลาที่ขอ: ${whenText} (เวลาประเทศไทย)`,
    wasYou:
      'หากคุณดำเนินการนี้ด้วยตนเอง กรุณาเปิดอีเมลยืนยันที่อีเมลใหม่ของคุณ และไม่ต้องดำเนินการอะไรเพิ่มเติม',
    wasNotYou:
      'หากคุณไม่ได้ดำเนินการนี้ แสดงว่ามีผู้อื่นเข้าถึงบัญชีของคุณได้ กรุณาเปลี่ยนรหัสผ่านทันที และออกจากระบบทุกอุปกรณ์ในการตั้งค่าบัญชีของคุณ โดยไม่ต้องใช้ลิงก์ใด ๆ จากอีเมลนี้ เพราะอีเมลนี้ไม่มีลิงก์โดยเจตนา หากอีเมลด้านบนไม่ใช่ของคุณ กรุณาติดต่อฝ่ายสนับสนุนของ Eventa',
  },
};

/**
 * The copy for a locale, falling back rather than returning `undefined`.
 *
 * Each table is a `Record<Locale, …>` and `notice.locale` is typed `Locale`, so
 * indexing looks total — and is not. This service only MIRRORS eventa-api's
 * `locale` pgEnum and Drizzle maps no enum values on the way in, so a language
 * added upstream arrives as a string these tables have no key for. Indexing it
 * then threw a `TypeError` while building the subject, BEFORE either send and
 * without the warn line a failed READ would have produced — and in THIS handler
 * that takes down the confirmation link as well as the warning, so the member
 * is left unable to complete a change they asked for.
 *
 * `common/messaging/locale.ts` coerces the value where it enters from the
 * database, which fixes the path that actually broke. This is the second guard,
 * here because this file is what indexes the tables.
 */
function copyFor<T>(table: Record<Locale, T>, locale: Locale): T {
  return table[locale] ?? table[DEFAULT_LOCALE];
}

export function emailChangeConfirmationSubject(
  notice: EmailChangeConfirmation,
): string {
  return copyFor(CONFIRMATION, notice.locale).subject;
}

/**
 * Addressed to a reader who may not have asked for this at all, so it says what
 * has NOT happened yet as plainly as what has: the sign-in address is unchanged
 * until the link is opened, and a stranger typed in by mistake is told to
 * ignore it rather than to go and defend an account they do not have.
 */
export function emailChangeConfirmationBody(
  notice: EmailChangeConfirmation,
): string {
  const t = copyFor(CONFIRMATION, notice.locale);
  return [
    confirmationGreeting(notice),
    '',
    t.confirm,
    notice.confirmUrl,
    '',
    t.expiry(LINK_LIFETIME_HOURS),
    '',
    t.ignore,
  ].join('\n');
}

/** `Hi <name>,` when a name survived sanitising, and a plain hello when not. */
function confirmationGreeting(notice: EmailChangeConfirmation): string {
  const name = safeDisplayName(notice.name);
  return name === null
    ? copyFor(NAMELESS_GREETING, notice.locale)
    : copyFor(CONFIRMATION, notice.locale).greeting(name);
}

export function emailChangeHeadsUpSubject(notice: EmailChangeHeadsUp): string {
  return copyFor(HEADS_UP, notice.locale).subject;
}

/**
 * The warning to the address the account is being moved away from. It reports
 * the request, names the destination, stamps WHEN so the reader can match it
 * against what they remember doing, and then says what to do if it was not
 * them. It contains no link, and says so.
 *
 * It also carries no FREE TEXT from the request — not even a greeting with the
 * account holder's name on it, so every sentence below is this service's own,
 * which is what lets the reader weigh it against the other mail they just
 * received. The one requested value it does print is the destination address,
 * which eventa-api constrains with `@IsEmail()` and so cannot hold a line
 * break; this service's own schema is a tolerant `z.string()`, so that is a
 * guarantee borrowed from the producer rather than one made here.
 */
export function emailChangeHeadsUpBody(notice: EmailChangeHeadsUp): string {
  const t = copyFor(HEADS_UP, notice.locale);
  return [
    copyFor(NAMELESS_GREETING, notice.locale),
    '',
    t.requested(notice.requestedEmail),
    t.notYet,
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
 * A timestamp this service cannot parse must not cost somebody their warning,
 * so an unreadable date drops the line rather than throwing or printing
 * "Invalid Date" — the same "omit rather than render blank" rule the two-factor
 * and cancellation notices follow. The rest of the warning is still true and
 * still worth sending.
 */
function whenLine(notice: EmailChangeHeadsUp, t: HeadsUpCopy): string[] {
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
