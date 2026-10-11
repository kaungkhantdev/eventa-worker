import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import type { Locale } from '../../db/schema/events';

/**
 * The "your password was changed" confirmation, in English and Thai
 * (US-ACC-05 / US-DISC-12 criterion 4).
 *
 * This is identity mail: it goes to the account holder about their own account,
 * so it is UNCONDITIONAL and consults no template catalog. An organizer may
 * switch off the workspace's attendee templates; they may not switch off
 * somebody's security correspondence, because the person whose password was
 * just changed by somebody holding their session is precisely the person an
 * organizer's template setting must not be able to silence.
 *
 * Like `auth-two-factor/two-factor-disabled.notice.ts`, which it is the sibling
 * of, this alert matters most when the reader did NOT do this — and that
 * decides the shape of the copy. It reports the change, stamps WHEN it happened
 * so the reader can match it against what they remember doing, says how many
 * other SIGN-INS the same operation signed out, and then says what to do if it
 * was not them.
 *
 * Sign-ins, not devices, because that is what is counted. A row in
 * `auth_sessions` is one sign-in: the same laptop signing in again after its
 * refresh token lapsed is a second row, so "two devices" could be one desk.
 * The number is still worth printing — it is how a reader judges how far
 * somebody else already was — but only said as the thing it measures.
 *
 * WHERE IT DIVERGES FROM THE TWO-FACTOR ALERT, AND WHY. That one can tell its
 * reader to change their password. This one cannot: the person who changed the
 * password is the only person who knows it, so the reader is locked out of the
 * obvious remedy. The one route back in that needs no current password is the
 * reset flow, and eventa-api's reset revokes EVERY session for the account
 * (`PasswordRepository.setPassword` with no `keepSessionId`), including the
 * device the change was made on — so saying so is both actionable and true.
 *
 * It still contains no link, for the genre's reason: everything a compromised
 * account needs happens behind a sign-in, and a security notice that trains
 * people to click a link in a security notice is the phishing lure it was
 * meant to warn them about. `identity.password_changed` carries no URL to put
 * in one, by the producer's deliberate choice.
 *
 * WHAT IT DOES NOT SAY. No device or IP address — the API does not reliably
 * know either for this request, and an invented "unknown device" line is worse
 * than silence on a security notice. No workspace name either, following the
 * two-factor alert: the event does not carry one. That omission is the one
 * judgement here worth revisiting, and it is recorded rather than hidden — an
 * organizer can hold accounts in several workspaces, and with no link to
 * resolve the ambiguity "your Eventa password was changed" does not say WHICH
 * account. The fix belongs in the contract (a `workspaceName` field, as
 * `identity.password_reset_requested` carries), not in a lookup invented here.
 *
 * THE "NO LINK" CLAIM IS ENFORCED, NOT MERELY INTENDED. The reader's name is
 * the one piece of free text here, and the session that can set it is the one
 * this notice reports — so it goes through `safeDisplayName` before it is
 * greeted with, and the greeting drops it entirely rather than print anything
 * that is not shaped like a name.
 *
 * "No link" is a claim about what the reader's CLIENT does with the text. A
 * name of "Support +66 81 234 5678" holds no scheme, slash or dot and is still
 * a tappable number in iOS Mail and Gmail on Android, which linkify a run of
 * digits into `tel:` — so the rule is an allow-list of what a name may contain
 * rather than a list of the link shapes anybody has thought of so far.
 */

/**
 * Security notices are stamped in Thailand's time, whatever the reader's own
 * clock says — the same rule receipts and the two-factor alert follow. The
 * timestamp crosses the bus in UTC; this is the only place it becomes a wall
 * clock.
 */
const NOTICE_TIMEZONE = 'Asia/Bangkok';

/** BCP-47 tag per locale; `th-TH` also gives a Thai reader the Buddhist era. */
const BCP47: Record<Locale, string> = { en: 'en-GB', th: 'th-TH' };

export interface PasswordChangedNotice {
  /**
   * The account holder, as their user record names them — free text written
   * through the API, so never rendered without {@link safeDisplayName}.
   */
  name: string;
  locale: Locale;
  /** When the API recorded the change. UTC on the wire, Bangkok on screen. */
  occurredAt: Date;
  /**
   * How many of the account's OTHER sessions the change revoked; the device the
   * change was made on is excluded and stays signed in.
   *
   * `0` and `undefined` are different answers and are rendered differently:
   * zero means the account had nothing else signed in, undefined means this
   * service was not told. Both drop the sentence — see {@link signedOutLine} —
   * but only one of them is a fact, and neither may be printed as a number.
   */
  otherSessionsSignedOut?: number;
}

/**
 * One language's strings. Declared so EN and TH must stay the same shape.
 *
 * `greeting` takes `string | null` because a name may be entirely unprintable
 * once it has been through {@link safeDisplayName} — the mail is addressed to
 * one mailbox and loses very little by not naming its reader, where the notice
 * would lose everything by not being sent.
 */
interface Copy {
  subject: string;
  greeting: (name: string | null) => string;
  changed: string;
  when: (whenText: string) => string;
  signedOut: (count: number) => string;
  wasYou: string;
  wasNotYou: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: 'Your Eventa password was changed',
    greeting: (name) => (name ? `Hi ${name},` : 'Hi,'),
    changed: 'Your Eventa account password was changed.',
    when: (whenText) => `When: ${whenText} (Bangkok time)`,
    signedOut: (count) =>
      count === 1
        ? 'One other sign-in to your account has been signed out. The one the change was made from is still signed in.'
        : `${count} other sign-ins to your account have been signed out. The one the change was made from is still signed in.`,
    wasYou: 'If you did this, there is nothing else to do.',
    wasNotYou:
      'If you did not do this, somebody else knows your password and is still signed in. Reset your password straight away: choose “Forgot your password?” on the Eventa sign-in page. That signs out every device, including theirs.',
  },
  th: {
    subject: 'รหัสผ่าน Eventa ของคุณถูกเปลี่ยน',
    greeting: (name) => (name ? `สวัสดีคุณ ${name}` : 'สวัสดี'),
    changed: 'รหัสผ่านของบัญชี Eventa ของคุณถูกเปลี่ยนแล้ว',
    when: (whenText) => `เวลา: ${whenText} (เวลาประเทศไทย)`,
    signedOut: (count) =>
      `การลงชื่อเข้าใช้บัญชีของคุณอีก ${count} รายการถูกออกจากระบบแล้ว ส่วนรายการที่ใช้เปลี่ยนรหัสผ่านยังลงชื่อเข้าใช้อยู่`,
    wasYou: 'หากคุณดำเนินการนี้ด้วยตนเอง ไม่ต้องดำเนินการอะไรเพิ่มเติม',
    wasNotYou:
      'หากคุณไม่ได้ดำเนินการนี้ แสดงว่ามีผู้อื่นทราบรหัสผ่านของคุณและยังลงชื่อเข้าใช้อยู่ กรุณาเลือก “ลืมรหัสผ่าน” ที่หน้าเข้าสู่ระบบของ Eventa และตั้งรหัสผ่านใหม่ทันที การตั้งรหัสผ่านใหม่จะออกจากระบบทุกอุปกรณ์ รวมถึงอุปกรณ์ของผู้อื่นด้วย',
  },
};

/**
 * A language this file has copy for, or {@link DEFAULT_LOCALE}.
 *
 * `COPY` is a `Record<Locale, Copy>` and `notice.locale` is typed `Locale`, so
 * indexing it looks total — and is not. This service only MIRRORS eventa-api's
 * `locale` pgEnum and Drizzle maps no enum values on the way in, so a language
 * added upstream arrives as a string this table has no key for. Indexing it
 * then throws a `TypeError` while building the subject, BEFORE the send and
 * without the warn line or counter a failed READ would have produced: the
 * notice rides the retry ladder into the dead-letter queue in silence. That is
 * not hypothetical — it happened to the two-factor alert.
 *
 * `common/messaging/locale.ts` coerces the value where it enters from the
 * database, which fixes the path that actually broke. This is the second
 * guard, here because this file is what indexes the table.
 *
 * It narrows the LOCALE rather than returning the `Copy`, because this file
 * holds two `Record<Locale, …>` tables and an unknown key must not survive
 * past the first of them: handed straight to `BCP47`, it yields `undefined`
 * and `toLocaleString` then formats the timestamp in whatever language the
 * container happens to be set to — a wrong wall clock quietly substituted for
 * a missing one, inside the line the reader is meant to check against their
 * memory. One narrowing, used by every table here.
 */
function knownLocale(locale: Locale): Locale {
  return COPY[locale] ? locale : DEFAULT_LOCALE;
}

export function passwordChangedSubject(notice: PasswordChangedNotice): string {
  return COPY[knownLocale(notice.locale)].subject;
}

export function passwordChangedBody(notice: PasswordChangedNotice): string {
  const locale = knownLocale(notice.locale);
  const t = COPY[locale];
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
    t.changed,
    ...whenLine(notice.occurredAt, locale, t),
    ...signedOutLine(notice, t),
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
 * notice, so an unreadable date drops the line rather than throwing or printing
 * "Invalid Date" — the same "omit rather than render blank" rule the two-factor
 * and cancellation notices follow. The rest of the notice is still true and
 * still worth sending.
 */
function whenLine(occurredAt: Date, locale: Locale, t: Copy): string[] {
  if (Number.isNaN(occurredAt.getTime())) return [];
  return ['', t.when(formatOccurredAt(occurredAt, locale))];
}

/**
 * The other-devices sentence, or nothing at all.
 *
 * Dropped for zero on the producer's own instruction: `0` says the account had
 * nothing else signed in, and "0 other devices have been signed out" sends the
 * reader hunting for a meaning that is not there. Dropped for `undefined` too,
 * which is what an unusable or missing count becomes in
 * `password-changed.schema.ts` — this service will not tell somebody who may be
 * reading about an intruder that nothing else was signed in when it does not
 * know that.
 */
function signedOutLine(notice: PasswordChangedNotice, t: Copy): string[] {
  const count = notice.otherSessionsSignedOut;
  if (count === undefined || count < 1) return [];
  return ['', t.signedOut(count)];
}

function formatOccurredAt(occurredAt: Date, locale: Locale): string {
  return occurredAt.toLocaleString(BCP47[locale], {
    timeZone: NOTICE_TIMEZONE,
    dateStyle: 'long',
    timeStyle: 'short',
  });
}
