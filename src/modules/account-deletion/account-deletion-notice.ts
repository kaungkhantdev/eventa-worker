import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import type { Locale } from '../../db/schema/events';
import { formatWhen } from '../registration/confirmation-email';

/**
 * The account-closure notice, in English and Thai (US-DISC-14).
 *
 * It describes what eventa-api ACTUALLY did, which is narrower than the phrase
 * "deletion requested" suggests. Reading `AccountDeletionService` /
 * `AccountDeletionRepository`, one transaction stamps `deleted_at` on the user
 * row and revokes every session, then writes this event. So:
 *
 * - **It has already happened.** There is no pending request, no grace period
 *   and no cancellation token on the wire, so the copy never offers an undo.
 *   A security notice that implies "click here if this wasn't you" when no such
 *   link exists wastes the one hour in which a victim might still act.
 * - **It says nothing about erasure having happened.** The PDPA anonymization
 *   that eventa-api's event comment describes is not performed by anything in
 *   this service today (see the module docstring), and a notice claiming
 *   personal data "has been removed" would be a promise no code keeps. What is
 *   certainly true — the account is closed, the sessions are gone, and
 *   finance/tax rows are retained for the statutory period — is what it says.
 * - **There is no organizer wording to honour.** This is the person's own
 *   security correspondence, like a password reset, not the workspace's
 *   message; every line is Eventa's.
 * - **"No link in this email" is enforced, not merely promised.** The reader's
 *   name is the one piece of free text here, and the person who closed this
 *   account may not have been its owner — whoever held the session could have
 *   renamed the profile first, since eventa-api accepts 200 characters of
 *   anything. So the name goes through {@link safeDisplayName} before it is
 *   greeted with, and the greeting drops it entirely rather than print
 *   anything that is not shaped like a name. Without that, a name of
 *   "Somchai\n\nURGENT: … https://evil.test/fix" would put an attacker's
 *   clickable host above the sentence that says no link can restore the
 *   account — and a name of "Support +66 81 234 5678" would put a number a
 *   phone turns into `tel:` there, carrying no URL punctuation to catch.
 */

/** Account mail has no event behind it, so it is dated in Thailand. */
const NOTICE_TIMEZONE = 'Asia/Bangkok';

export interface ClosureNotice {
  locale: Locale;
  /**
   * The account holder, as their user record named them — free text written
   * through the API, so never rendered without {@link safeDisplayName}.
   */
  name: string;
  /** When eventa-api closed the account — `occurredAt`, UTC off the wire. */
  deletedAt: Date;
}

/**
 * `greeting` takes `string | null` because a name may be entirely unprintable
 * once it has been through {@link safeDisplayName}. The notice is addressed to
 * one mailbox and loses very little by not naming its reader, where the warning
 * would lose everything by not being sent.
 */
interface Copy {
  subject: string;
  greeting: (name: string | null) => string;
  closed: (when: string | null) => string;
  signedOut: string;
  final: string;
  retained: string;
  notYou: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: 'Your Eventa account has been deleted',
    greeting: (name) => (name ? `Hi ${name},` : 'Hi,'),
    closed: (when) =>
      when
        ? `Your Eventa account was deleted on ${when} (Bangkok time), at your request.`
        : 'Your Eventa account was deleted, at your request.',
    signedOut:
      'You have been signed out on every device, and the account can no longer be signed in to.',
    final:
      'This cannot be undone. There is no waiting period to cancel and no link in this email that restores the account — if you want to use Eventa again, you will need to sign up afresh.',
    retained:
      'Payment and tax records we are required by law to keep are retained for the statutory period and are no longer linked to your profile.',
    notYou:
      'If you did not do this, somebody knew your password — and your authenticator code, if you had two-factor turned on. Contact Eventa support straight away, and change that password anywhere else you have used it.',
  },
  th: {
    subject: 'บัญชี Eventa ของคุณถูกลบแล้ว',
    greeting: (name) => (name ? `สวัสดีคุณ ${name}` : 'สวัสดี'),
    closed: (when) =>
      when
        ? `บัญชี Eventa ของคุณถูกลบเมื่อ ${when} (เวลาประเทศไทย) ตามที่คุณร้องขอ`
        : 'บัญชี Eventa ของคุณถูกลบแล้ว ตามที่คุณร้องขอ',
    signedOut:
      'คุณถูกออกจากระบบในทุกอุปกรณ์แล้ว และจะไม่สามารถเข้าสู่ระบบด้วยบัญชีนี้ได้อีก',
    final:
      'การดำเนินการนี้ไม่สามารถย้อนกลับได้ ไม่มีระยะเวลารอให้ยกเลิก และไม่มีลิงก์ในอีเมลนี้ที่จะกู้คืนบัญชีได้ หากคุณต้องการใช้ Eventa อีกครั้ง คุณจะต้องสมัครใหม่',
    retained:
      'บันทึกการชำระเงินและเอกสารภาษีที่กฎหมายกำหนดให้เราเก็บรักษา จะถูกเก็บไว้ตามระยะเวลาที่กฎหมายกำหนด และไม่เชื่อมโยงกับโปรไฟล์ของคุณอีกต่อไป',
    notYou:
      'หากคุณไม่ได้ดำเนินการนี้ แสดงว่ามีผู้อื่นทราบรหัสผ่านของคุณ และทราบรหัสยืนยันตัวตนด้วย หากคุณเปิดใช้การยืนยันตัวตนสองขั้นตอนไว้ กรุณาติดต่อฝ่ายสนับสนุนของ Eventa ทันที และเปลี่ยนรหัสผ่านดังกล่าวในบริการอื่นที่คุณใช้ร่วมกัน',
  },
};

/**
 * The closure time, or null when the wire carried a timestamp we cannot read.
 * `toLocaleString` renders an unparseable date as the literal "Invalid Date",
 * and a security notice is the last place to print that — the sentence drops
 * the clause instead, the way every other email here omits an unfilled field.
 */
function formattedAt(notice: ClosureNotice): string | null {
  if (Number.isNaN(notice.deletedAt.getTime())) return null;
  return formatWhen(notice.deletedAt, NOTICE_TIMEZONE, notice.locale);
}

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

export function closureSubject(notice: ClosureNotice): string {
  return copyFor(notice.locale).subject;
}

export function closureBody(notice: ClosureNotice): string {
  const t = copyFor(notice.locale);
  return [
    // Deliberately nameless, and this is the fix rather than an omission.
    //
    // The name is attacker-controlled through exactly the session this
    // notice reports, and no shape rule can separate a name from a sentence
    // in a script written without inter-word spaces. `safeDisplayName`'s
    // word cap counts `name.split(' ')`, so a 48-code-point Thai imperative
    // — `ด่วนบัญชีถูกแฮกโปรดโทรฝ่ายสนับสนุนทันทีเดี๋ยวนี้`, "URGENT your
    // account was hacked, call support now" — is ONE word and passes every
    // cap. In a Thai-market product that is the primary locale, so the
    // defence failed exactly where it was needed most.
    //
    // Lengthening the rule cannot close it: any cap generous enough for
    // `พลตำรวจเอก ประภัสสราภรณ์ ศรีวรรณวิทย์ไพศาล` (42) admits a sentence of
    // 48. So the greeting drops the name instead, which removes the position
    // where somebody else's words can wear Eventa's voice. The mail is
    // addressed to one mailbox and nothing in the warning depended on the
    // name — `display-name.ts` said as much before this needed it.
    t.greeting(null),
    '',
    t.closed(formattedAt(notice)),
    t.signedOut,
    '',
    t.final,
    '',
    t.retained,
    '',
    t.notYou,
  ].join('\n');
}
