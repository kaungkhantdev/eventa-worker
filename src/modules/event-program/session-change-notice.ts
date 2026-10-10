import { greeting } from '../../common/messaging/greeting';
import { inlineText } from '../../common/messaging/inline-text';
import type { Locale } from '../../db/schema/events';

/**
 * The "a session you have on your schedule has moved" notice, in English and
 * Thai (US-PROG-03).
 *
 * It states WHAT moved and TO WHAT. A notice saying only that a session
 * changed makes every reader open the app to find out what, which is the
 * message not doing its job — and only the producer still knows the before, so
 * if this does not print it, nothing can.
 *
 * It also always closes by saying the ticket is unaffected. A rescheduled
 * session arriving with no such line reads like a cancellation, and the one
 * thing this message must not do is frighten somebody into writing in.
 */

/** A value before and after it moved. Absent (null) when it did not. */
export interface Change<T> {
  before: T;
  after: T;
}

export interface SessionChangeNotice {
  locale: Locale;
  attendeeName: string;
  eventName: string;
  sessionTitle: string;
  /** Already rendered in the reader's language; null when the when held. */
  when: Change<string> | null;
  /** Null when the room held; a null INSIDE it means no room was announced. */
  room: Change<string | null> | null;
}

/** One language's strings. Declared so EN and TH must stay the same shape. */
interface Copy {
  subject: (session: string) => string;
  rescheduled: (event: string) => string;
  movedRoom: (event: string) => string;
  session: string;
  when: string;
  where: string;
  /** A room the organizer has not named yet — never printed as a blank. */
  noRoom: string;
  unaffected: (event: string) => string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: (session) => `Session moved: ${session}`,
    rescheduled: (event) =>
      `A session on the programme for ${event} has been rescheduled.`,
    movedRoom: (event) =>
      `A session on the programme for ${event} has moved to a different room.`,
    session: 'Session',
    when: 'When',
    where: 'Where',
    noRoom: 'Not announced yet',
    unaffected: (event) =>
      `Your ticket is unaffected and nothing else about ${event} has changed.`,
  },
  th: {
    subject: (session) => `เปลี่ยนกำหนดการ: ${session}`,
    rescheduled: (event) =>
      `มีการเปลี่ยนวันหรือเวลาของเซสชันหนึ่งในกำหนดการงาน ${event}`,
    movedRoom: (event) =>
      `มีการเปลี่ยนห้องของเซสชันหนึ่งในกำหนดการงาน ${event}`,
    session: 'เซสชัน',
    when: 'วันเวลา',
    where: 'สถานที่',
    noRoom: 'ยังไม่ประกาศ',
    unaffected: (event) =>
      `บัตรของคุณยังใช้ได้ตามปกติ และรายละเอียดอื่นของงาน ${event} ไม่มีการเปลี่ยนแปลง`,
  },
};

/** ` → ` — the before and the after, in the order they happened. */
const TO = ' → ';

export function sessionChangeSubject(notice: SessionChangeNotice): string {
  return inlineText(COPY[notice.locale].subject(notice.sessionTitle));
}

export function sessionChangeBody(notice: SessionChangeNotice): string {
  const t = COPY[notice.locale];
  return [
    greeting(notice.locale, notice.attendeeName),
    '',
    notice.when
      ? t.rescheduled(notice.eventName)
      : t.movedRoom(notice.eventName),
    '',
    `${t.session}: ${notice.sessionTitle}`,
    // Each line is OMITTED rather than printed with nothing in it: US-MSG-01 is
    // explicit that a message never goes out with a field left unfilled, and a
    // reader told the room moved from nowhere to nowhere learns nothing.
    ...(notice.when ? [`${t.when}: ${change(notice.when)}`] : []),
    ...(notice.room ? [`${t.where}: ${roomChange(notice.room, t)}`] : []),
    '',
    t.unaffected(notice.eventName),
  ].join('\n');
}

function change(moved: Change<string>): string {
  return `${moved.before}${TO}${moved.after}`;
}

function roomChange(moved: Change<string | null>, t: Copy): string {
  return change({
    before: moved.before ?? t.noRoom,
    after: moved.after ?? t.noRoom,
  });
}
