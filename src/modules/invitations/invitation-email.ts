import { inlineText } from '../../common/messaging/inline-text';
import type { Locale } from '../../db/schema/events';

/**
 * The invitation email, in English and Thai (US-REG-06).
 *
 * Four things are always Eventa's and always present: WHAT the invitation is
 * an invitation to, when it starts, the link that registers for it, and that
 * no seat is held until the reader uses that link. An organizer rewording the
 * opening may replace Eventa's greeting; it may not leave the reader a mail
 * made entirely of the organizer's own words. See {@link opening}.
 *
 * The organizer's PER-INVITE note is separate from their reworded opening and
 * sits above everything, which is AC2 read literally: "that note appears at
 * the top of the invitation email". It is their own words to one person, so it
 * is printed as written — and so it, not the greeting, is the widest piece of
 * organizer free text in this mail. `invitation-name.ts` records why that
 * bounds how much the name rule beside it can be worth.
 */

export interface InvitationNotice {
  locale: Locale;
  /**
   * Already through `invitation-name.ts`; null → greet without a name, and
   * any organizer wording that asked for one falls back to the copy below.
   */
  name: string | null;
  eventName: string;
  /** Already formatted in the event's timezone — this module does no date maths. */
  whenText: string;
  /** ABSOLUTE link into the event's registration flow. */
  registerUrl: string;
  /** The organizer's personal note for this one invitation. */
  note: string | null;
  /**
   * The organizer's workspace-level subject, where they wrote one AND this
   * invitation could fill it — see `invitation-wording.ts`.
   */
  subject?: string | null;
  /**
   * Their workspace-level opening. It replaces the greeting LINE and nothing
   * else — {@link opening} is where that is now enforced rather than merely
   * stated.
   */
  opening?: string | null;
}

/** One language's strings. Declared so EN and TH must stay the same shape. */
interface Copy {
  subject: (event: string) => string;
  /**
   * Kept here rather than taken from `common/messaging/greeting.ts` on
   * purpose: that helper greets with any name it can flatten to one line,
   * which is right for a reader's own name and wrong for an organizer's claim
   * about a stranger. `invitation-name.ts` says why.
   */
  greeting: (name: string) => string;
  /**
   * For a name `invitation-name.ts` declined. The invitation still goes: it
   * loses the personal address, which is a real cost on mail to a stranger,
   * and keeps the event, the time and the link, which are what it is for.
   */
  greetingWithoutName: string;
  invited: (event: string) => string;
  when: string;
  registerHere: string;
  noSeatHeld: string;
  closing: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: (event) => `You're invited to ${event}`,
    greeting: (name) => `Hi ${name},`,
    greetingWithoutName: 'Hello,',
    invited: (event) => `You've been invited to ${event}.`,
    when: 'When',
    registerHere: 'Register here:',
    noSeatHeld:
      'A place isn’t held until you register, so do it while there is room.',
    closing: 'Hope to see you there.',
  },
  th: {
    subject: (event) => `คุณได้รับเชิญไปงาน ${event}`,
    greeting: (name) => `สวัสดีคุณ ${name}`,
    greetingWithoutName: 'สวัสดี',
    invited: (event) => `คุณได้รับเชิญให้เข้าร่วมงาน ${event}`,
    when: 'วันและเวลา',
    registerHere: 'ลงทะเบียนที่นี่:',
    noSeatHeld:
      'ที่นั่งจะยังไม่ถูกจองไว้จนกว่าคุณจะลงทะเบียน จึงควรลงทะเบียนตั้งแต่ยังมีที่ว่าง',
    closing: 'หวังว่าจะได้พบคุณที่งาน',
  },
};

export function invitationSubject(notice: InvitationNotice): string {
  // Flattened like every other subject: both sources are borrowed free text
  // with no charset rule — the event's name, and the organizer's own template
  // subject — and a second line in a subject is a second header.
  return inlineText(
    notice.subject || COPY[notice.locale].subject(notice.eventName),
  );
}

export function invitationBody(notice: InvitationNotice): string {
  const t = COPY[notice.locale];
  return [
    ...(notice.note ? [notice.note, ''] : []),
    ...opening(notice, t),
    '',
    `${t.when}: ${notice.whenText}`,
    '',
    t.registerHere,
    notice.registerUrl,
    '',
    t.noSeatHeld,
    '',
    t.closing,
  ].join('\n');
}

/**
 * The organizer's wording in place of Eventa's greeting — and then Eventa's
 * own sentence either way.
 *
 * The organizer's opening replaces the GREETING, which is what
 * `InvitationNotice.opening` has always said it does. It used to replace
 * `t.invited` with it, so a workspace template could send an invitation that
 * never said what it was an invitation to: everything above the `When:` line
 * was then the organizer's text, in Eventa's voice, with nothing of Eventa's
 * left for the reader to compare it against. That matters most for the mail
 * this module cannot fully vet — see `invitation-name.ts` on what a name rule
 * can and cannot decide — so the sentence naming the event is unconditional,
 * the same way the register link and the no-seat-held line already are.
 */
function opening(notice: InvitationNotice, t: Copy): string[] {
  const greet = notice.opening ?? greeting(notice, t);
  return [greet, '', t.invited(inlineText(notice.eventName))];
}

function greeting(notice: InvitationNotice, t: Copy): string {
  return notice.name
    ? t.greeting(inlineText(notice.name))
    : t.greetingWithoutName;
}
