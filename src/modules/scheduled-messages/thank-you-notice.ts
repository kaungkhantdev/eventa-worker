import type { Locale } from '../../db/schema/events';

/**
 * The post-event thank-you, in English and Thai (US-MSG-08).
 *
 * Its job is the survey link — the story's note is explicit that this message
 * is what distributes it. So the link is always the last thing in the body and
 * always Eventa's, in both languages: an organizer rewriting the greeting must
 * not be able to send a thank-you nobody can act on.
 */

export interface ThankYouNotice {
  attendeeName: string;
  eventName: string;
  surveyUrl: string;
  locale: Locale;
  /** The organizer's subject, already filled. Null or absent: use Eventa's. */
  subject?: string | null;
  /** The organizer's opening, already filled. Null or absent: use Eventa's. */
  opening?: string | null;
}

interface Copy {
  subject: (event: string) => string;
  greeting: (name: string) => string;
  thanks: (event: string) => string;
  ask: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: (event) => `Thanks for coming to ${event}`,
    greeting: (name) => `Hi ${name},`,
    thanks: (event) =>
      `Thanks for coming to ${event} — we hope you had a great time.`,
    ask: 'It takes a minute to tell the organizer how it went:',
  },
  th: {
    subject: (event) => `ขอบคุณที่มาร่วมงาน ${event}`,
    greeting: (name) => `สวัสดีคุณ ${name}`,
    thanks: (event) => `ขอบคุณที่มาร่วมงาน ${event} หวังว่าคุณจะประทับใจ`,
    ask: 'ใช้เวลาเพียงนาทีเดียวเพื่อบอกผู้จัดงานว่างานเป็นอย่างไร:',
  },
};

export function thankYouSubject(notice: ThankYouNotice): string {
  return notice.subject || COPY[notice.locale].subject(notice.eventName);
}

export function thankYouBody(notice: ThankYouNotice): string {
  const t = COPY[notice.locale];
  const opening = notice.opening
    ? [notice.opening]
    : [t.greeting(notice.attendeeName), '', t.thanks(notice.eventName)];
  return [...opening, '', t.ask, notice.surveyUrl].join('\n');
}

/**
 * The absolute link to an event's survey in the attendee portal.
 *
 * Absolute because a root-relative path is inert in a mail client, and built
 * here rather than in a template so a trailing slash on the configured base
 * cannot produce `//portal`.
 */
export function surveyUrlFor(publicWebUrl: string, eventId: string): string {
  const base = publicWebUrl.replace(/\/+$/, '');
  return `${base}/portal/survey?event=${encodeURIComponent(eventId)}`;
}
