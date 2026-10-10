import { greeting } from '../../common/messaging/greeting';
import { inlineText } from '../../common/messaging/inline-text';
import type { Locale } from '../../db/schema/events';

/** Satang per baht — money crosses the bus as an integer and is formatted here. */
const SATANG_PER_BAHT = 100;

/**
 * What the email says about one ticket. Note what is ABSENT: the QR token.
 * It is a bearer credential that admits someone to a paid event and stays
 * valid until check-in, so it does not belong in plain-text mail — which is
 * logged, forwarded, and scanned. The email names the ticket and links to the
 * authenticated page that renders the scannable code.
 */
export interface ConfirmationTicket {
  holderName: string | null;
  ticketLabel: string | null;
}

export interface ConfirmationDetails {
  locale: Locale;
  buyerName: string;
  reference: string;
  eventName: string;
  /** Already formatted in the event's timezone — this module does no date maths. */
  whenText: string;
  /** Venue line, or the join note for an online event; null when neither is set. */
  whereText: string | null;
  isOnline: boolean;
  totalSatang: number;
  currency: string;
  paid: boolean;
  tickets: readonly ConfirmationTicket[];
  /** ABSOLUTE link to the page that renders the scannable codes. */
  ticketsUrl: string;
}

/** One language's strings. Declared so EN and TH must stay the same shape. */
interface Copy {
  subject: (event: string) => string;
  confirmed: (event: string) => string;
  reference: string;
  when: string;
  where: string;
  online: string;
  total: string;
  free: string;
  ticketsHeading: (n: number) => string;
  ticketLine: (label: string, holder: string) => string;
  openTickets: string;
  closing: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: (event: string) => `You're going to ${event}`,
    confirmed: (event: string) =>
      `Your registration for ${event} is confirmed.`,
    reference: 'Booking reference',
    when: 'When',
    where: 'Where',
    online: 'Online',
    total: 'Total paid',
    free: 'Free registration',
    ticketsHeading: (n: number) =>
      n === 1 ? 'Your ticket' : `Your ${n} tickets`,
    ticketLine: (label: string, holder: string) => `${label} — ${holder}`,
    openTickets: 'Open your tickets to show at the door:',
    closing: 'See you there.',
  },
  th: {
    subject: (event: string) => `คุณกำลังจะไป ${event}`,
    confirmed: (event: string) =>
      `การลงทะเบียนของคุณสำหรับ ${event} ได้รับการยืนยันแล้ว`,
    reference: 'รหัสการจอง',
    when: 'วันและเวลา',
    where: 'สถานที่',
    online: 'ออนไลน์',
    total: 'ยอดชำระทั้งหมด',
    free: 'ลงทะเบียนฟรี',
    ticketsHeading: (n: number) =>
      n === 1 ? 'บัตรของคุณ' : `บัตรของคุณ ${n} ใบ`,
    ticketLine: (label: string, holder: string) => `${label} — ${holder}`,
    openTickets: 'เปิดดูบัตรของคุณเพื่อแสดงที่หน้างาน:',
    closing: 'แล้วพบกัน',
  },
};

/** BCP-47 tag per locale; `th-TH` also gives Thai numerals' grouping and era. */
const BCP47: Record<Locale, string> = { en: 'en-GB', th: 'th-TH' };

/** ฿1,880.00 — satang formatted once, at the edge, in the reader's language. */
export function formatMoney(
  satang: number,
  currency: string,
  locale: Locale,
): string {
  const amount = (satang / SATANG_PER_BAHT).toLocaleString(BCP47[locale], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'THB' ? `฿${amount}` : `${amount} ${currency}`;
}

/**
 * The door time, in the EVENT's timezone and the READER's language. A Thai
 * email with an English date is half-translated — and `th-TH` also renders the
 * Buddhist era a Thai reader expects.
 */
export function formatWhen(
  startAt: Date,
  timezone: string,
  locale: Locale,
): string {
  return startAt.toLocaleString(BCP47[locale], {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  });
}

export function confirmationSubject(
  details: ConfirmationDetails,
  override?: string | null,
): string {
  return inlineText(
    override || COPY[details.locale].subject(details.eventName),
  );
}

/**
 * The confirmation body, in the recipient's language (US-MSG-01).
 *
 * Every line is built from a value the caller resolved; a field with nothing
 * behind it is OMITTED rather than rendered blank, because the story is
 * explicit that "a message is never sent with a personalization field left
 * unfilled" — an email reading "Where: null" is worse than one with no venue
 * line at all.
 */
export function confirmationBody(
  details: ConfirmationDetails,
  intro?: string | null,
): string {
  const t = COPY[details.locale];
  return [
    // An organizer's wording replaces the OPENING only (US-MSG-02). Everything
    // below — the reference, the ticket list, the link that renders the QR —
    // is always Eventa's, because an attendee losing their ticket because
    // somebody rewrote a greeting is not a wording choice anybody meant to
    // make.
    ...(intro
      ? [intro]
      : [
          greeting(details.locale, details.buyerName),
          '',
          t.confirmed(inlineText(details.eventName)),
        ]),
    '',
    `${t.reference}: ${details.reference}`,
    `${t.when}: ${details.whenText}`,
    ...whereLine(details, t),
    totalLine(details, t),
    '',
    t.ticketsHeading(details.tickets.length),
    ...details.tickets.map((ticket) => ticketLines(ticket, details, t)).flat(),
    '',
    `${t.openTickets} ${details.ticketsUrl}`,
    '',
    t.closing,
  ].join('\n');
}

function whereLine(details: ConfirmationDetails, t: Copy): string[] {
  const where = details.whereText ? inlineText(details.whereText) : null;
  if (details.isOnline) return [`${t.where}: ${where ?? t.online}`];
  return where ? [`${t.where}: ${where}`] : [];
}

function totalLine(details: ConfirmationDetails, t: Copy): string {
  return details.paid
    ? `${t.total}: ${formatMoney(details.totalSatang, details.currency, details.locale)}`
    : t.free;
}

function ticketLines(
  ticket: ConfirmationTicket,
  details: ConfirmationDetails,
  t: Copy,
): string[] {
  // The only name in this service printed outside a greeting, so the one place
  // that still has to ask for the rule by hand. `holderName` is the buyer's own
  // name too — eventa-api writes it from `order.buyerName` at issue — but the
  // line is a ticket's holder, not a salutation, so it has no nameless form to
  // fall back to and prints whatever survives.
  const label = inlineText(ticket.ticketLabel ?? details.eventName);
  const holder = inlineText(ticket.holderName ?? details.buyerName);
  return [`  ${t.ticketLine(label, holder)}`];
}
