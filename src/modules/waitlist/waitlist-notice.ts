import { greeting } from '../../common/messaging/greeting';
import { inlineText } from '../../common/messaging/inline-text';
import type { Locale } from '../../db/schema/events';
import { formatMoney, formatWhen } from '../registration/confirmation-email';

/**
 * The waitlist emails, in English and Thai (US-REG-04): the offer — "a
 * time-limited offer … to complete payment" — and the notice that it lapsed.
 *
 * In the offer, the seats, the price, the deadline and the pay link are always
 * Eventa's and always present. They are the offer; an organizer rewording the
 * greeting must not be able to send one that no longer says what to pay, by
 * when, or where. The lapse notice is Eventa's throughout: the organizer's
 * wording was written for the offer, and would read as one.
 */

export interface OfferNotice {
  locale: Locale;
  name: string;
  eventName: string;
  ticketTypeName: string;
  ticketCount: number;
  totalSatang: number;
  currency: string;
  offerExpiresAt: Date;
  /** The EVENT's timezone — the clock the attendee lives by for this event. */
  timezone: string;
  payUrl: string;
  subject?: string | null;
  opening?: string | null;
}

export interface ExpiredNotice {
  locale: Locale;
  name: string;
  eventName: string;
}

/** The slice of an order that says whether its offer can still be taken up. */
export interface OfferState {
  status: string;
  paymentStatus: string;
  offerExpiresAt: Date | null;
}

interface Copy {
  offerSubject: (event: string) => string;
  opened: (event: string) => string;
  payBy: string;
  payHere: string;
  passesOn: string;
  expiredSubject: (event: string) => string;
  expired: (event: string) => string;
  offList: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    offerSubject: (event) => `A seat is waiting for you at ${event}`,
    opened: (event) =>
      `Good news — a place has opened up at ${event}, and we're holding it for you.`,
    payBy: 'Pay by',
    payHere: 'Complete your payment here to claim it:',
    passesOn:
      "If it isn't paid for by then, it goes to the next person on the waitlist.",
    expiredSubject: (event) => `Your waitlist offer for ${event} has expired`,
    expired: (event) =>
      `The place we held for you at ${event} wasn't paid for in time, so it has gone to the next person on the waitlist.`,
    offList:
      "You're no longer on the waitlist for this event. If tickets come up again, you can join it once more from the event page.",
  },
  th: {
    offerSubject: (event) => `มีที่นั่งรอคุณอยู่ที่ ${event}`,
    opened: (event) =>
      `ข่าวดี มีที่ว่างสำหรับ ${event} และเราเก็บไว้ให้คุณแล้ว`,
    payBy: 'ชำระเงินภายใน',
    payHere: 'ชำระเงินที่นี่เพื่อยืนยันที่นั่งของคุณ:',
    passesOn:
      'หากไม่ได้ชำระเงินภายในเวลาดังกล่าว ที่นั่งจะส่งต่อให้ผู้ที่รอคิวถัดไป',
    expiredSubject: (event) => `ข้อเสนอที่นั่งสำหรับ ${event} หมดอายุแล้ว`,
    expired: (event) =>
      `ที่นั่งที่เราเก็บไว้ให้คุณสำหรับ ${event} ไม่ได้รับการชำระเงินภายในเวลาที่กำหนด จึงส่งต่อให้ผู้ที่รอคิวถัดไปแล้ว`,
    offList:
      'ขณะนี้คุณไม่ได้อยู่ในรายชื่อรอสำหรับงานนี้แล้ว หากมีบัตรว่างอีกครั้ง คุณสามารถลงชื่อรอได้ใหม่จากหน้างาน',
  },
};

export function offerSubject(notice: OfferNotice): string {
  return inlineText(
    notice.subject || COPY[notice.locale].offerSubject(notice.eventName),
  );
}

export function offerBody(notice: OfferNotice): string {
  const t = COPY[notice.locale];
  const opening = notice.opening
    ? [notice.opening]
    : [greeting(notice.locale, notice.name), '', t.opened(notice.eventName)];
  const price = formatMoney(notice.totalSatang, notice.currency, notice.locale);
  return [
    ...opening,
    '',
    `${notice.ticketTypeName} × ${notice.ticketCount}: ${price}`,
    `${t.payBy}: ${formatWhen(notice.offerExpiresAt, notice.timezone, notice.locale)}`,
    '',
    t.payHere,
    notice.payUrl,
    '',
    t.passesOn,
  ].join('\n');
}

export function expiredSubject(notice: ExpiredNotice): string {
  return inlineText(COPY[notice.locale].expiredSubject(notice.eventName));
}

export function expiredBody(notice: ExpiredNotice): string {
  const t = COPY[notice.locale];
  return [
    greeting(notice.locale, notice.name),
    '',
    t.expired(notice.eventName),
    '',
    t.offList,
  ].join('\n');
}

/**
 * Whether an offer can still be taken up. The outbox and the queue can run
 * behind, and "pay now" for a seat that is already theirs — or already
 * somebody else's — is worse than no email at all.
 */
export function offerStillOpen(state: OfferState, now: Date): boolean {
  return (
    state.status === 'pending' &&
    state.paymentStatus === 'pending' &&
    state.offerExpiresAt !== null &&
    state.offerExpiresAt.getTime() > now.getTime()
  );
}
