import type { Locale } from '../../db/schema/events';

/**
 * The invitation email, in English and Thai (US-REG-06).
 *
 * Three things are always Eventa's and always present: what the event is, when
 * it starts, and the link that registers for it. An organizer rewording the
 * opening must not be able to send an invitation that no longer says where to
 * accept it — and the story's own note is that an invite reserves no seat, so
 * the mail says that too rather than letting the reader assume otherwise.
 *
 * The organizer's PER-INVITE note is separate from their reworded opening and
 * sits above everything, which is AC2 read literally: "that note appears at
 * the top of the invitation email". It is their own words to one person, so it
 * is printed as written.
 */

export interface InvitationNotice {
  locale: Locale;
  /** Already made safe to interpolate; null → greet without a name. */
  name: string | null;
  eventName: string;
  /** Already formatted in the event's timezone — this module does no date maths. */
  whenText: string;
  /** ABSOLUTE link into the event's registration flow. */
  registerUrl: string;
  /** The organizer's personal note for this one invitation. */
  note: string | null;
  /** The organizer's workspace-level subject, where they wrote one. */
  subject?: string | null;
  /** Their workspace-level opening, which replaces the greeting only. */
  opening?: string | null;
}

/** One language's strings. Declared so EN and TH must stay the same shape. */
interface Copy {
  subject: (event: string) => string;
  greeting: (name: string) => string;
  /** For a name that sanitised away to nothing — a mail to one mailbox. */
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
  return notice.subject || COPY[notice.locale].subject(notice.eventName);
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

/** The organizer's wording, or Eventa's greeting and the invitation itself. */
function opening(notice: InvitationNotice, t: Copy): string[] {
  if (notice.opening) return [notice.opening];
  return [greeting(notice, t), '', t.invited(notice.eventName)];
}

function greeting(notice: InvitationNotice, t: Copy): string {
  return notice.name ? t.greeting(notice.name) : t.greetingWithoutName;
}
