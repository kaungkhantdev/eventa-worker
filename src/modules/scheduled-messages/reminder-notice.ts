import { greeting } from '../../common/messaging/greeting';
import { inlineText } from '../../common/messaging/inline-text';
import type { Locale } from '../../db/schema/events';
import { formatWhen } from '../registration/confirmation-email';

/**
 * The event reminder, in English and Thai (US-MSG-01) — "Given my event is a
 * day away, I receive a reminder with the event time and place."
 *
 * The time, the place and the link to the ticket are always Eventa's and
 * always present, in both languages. They are why the message exists: an
 * organizer rewriting the greeting must not be able to send a reminder that no
 * longer says when or where.
 */

export interface ReminderNotice {
  attendeeName: string;
  eventName: string;
  startAt: Date;
  /** The EVENT's timezone — the wall clock the attendee will actually arrive by. */
  timezone: string;
  /** "QSNCC, Bangkok", the online note, or null when there is genuinely none. */
  where: string | null;
  myEventsUrl: string;
  locale: Locale;
  subject?: string | null;
  opening?: string | null;
}

interface Copy {
  subject: (event: string) => string;
  soon: (event: string) => string;
  when: string;
  where: string;
  tickets: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: (event) => `Tomorrow: ${event}`,
    soon: (event) => `A reminder that ${event} is coming up.`,
    when: 'When',
    where: 'Where',
    tickets: 'Your tickets and QR codes:',
  },
  th: {
    subject: (event) => `พรุ่งนี้: ${event}`,
    soon: (event) => `ขอเตือนว่า ${event} ใกล้จะถึงแล้ว`,
    when: 'วันเวลา',
    where: 'สถานที่',
    tickets: 'บัตรและคิวอาร์โค้ดของคุณ:',
  },
};

export function reminderSubject(notice: ReminderNotice): string {
  return inlineText(
    notice.subject || COPY[notice.locale].subject(notice.eventName),
  );
}

export function reminderBody(notice: ReminderNotice): string {
  const t = COPY[notice.locale];
  const opening = notice.opening
    ? [notice.opening]
    : [
        greeting(notice.locale, notice.attendeeName),
        '',
        // Flattened: the organizer's text, read by an attendee. `opening`
        // below is deliberately NOT flattened — it is the organizer's own
        // message and is meant to run to several lines.
        t.soon(inlineText(notice.eventName)),
      ];
  return [
    ...opening,
    '',
    `${t.when}: ${formatWhen(notice.startAt, notice.timezone, notice.locale)}`,
    // Omitted rather than printed blank: "Where: " with nothing after it is a
    // personalization field left unfilled.
    ...(notice.where ? [`${t.where}: ${inlineText(notice.where)}`] : []),
    '',
    t.tickets,
    notice.myEventsUrl,
  ].join('\n');
}

/** Absolute, because a root-relative link is dead in a mail client. */
export function myEventsUrlFor(publicWebUrl: string): string {
  return `${publicWebUrl.replace(/\/+$/, '')}/portal/my-events`;
}
