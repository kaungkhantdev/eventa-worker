import type { Locale } from '../../db/schema/events';

/** Satang per baht — money crosses the bus as an integer and is formatted here. */
const SATANG_PER_BAHT = 100;

export interface ConfirmationTicket {
  qrToken: string;
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
  /** Where the attendee opens the live ticket with its scannable QR. */
  ticketsUrl: string;
}

/** One language's strings. Declared so EN and TH must stay the same shape. */
interface Copy {
  subject: (event: string) => string;
  greeting: (name: string) => string;
  confirmed: (event: string) => string;
  reference: string;
  when: string;
  where: string;
  online: string;
  total: string;
  free: string;
  ticketsHeading: (n: number) => string;
  ticketLine: (label: string, holder: string) => string;
  showQr: string;
  openTickets: string;
  closing: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: (event: string) => `You're going to ${event}`,
    greeting: (name: string) => `Hi ${name},`,
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
    showQr: 'Show this at the door:',
    openTickets: 'Open your tickets:',
    closing: 'See you there.',
  },
  th: {
    subject: (event: string) => `คุณกำลังจะไป ${event}`,
    greeting: (name: string) => `สวัสดีคุณ ${name}`,
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
    showQr: 'แสดงรหัสนี้ที่หน้างาน:',
    openTickets: 'เปิดดูบัตรของคุณ:',
    closing: 'แล้วพบกัน',
  },
};

/** ฿1,880.00 — satang formatted once, at the edge. */
export function formatMoney(satang: number, currency: string): string {
  const amount = (satang / SATANG_PER_BAHT).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'THB' ? `฿${amount}` : `${amount} ${currency}`;
}

export function confirmationSubject(details: ConfirmationDetails): string {
  return COPY[details.locale].subject(details.eventName);
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
export function confirmationBody(details: ConfirmationDetails): string {
  const t = COPY[details.locale];
  return [
    t.greeting(details.buyerName),
    '',
    t.confirmed(details.eventName),
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
  if (details.isOnline) return [`${t.where}: ${details.whereText ?? t.online}`];
  return details.whereText ? [`${t.where}: ${details.whereText}`] : [];
}

function totalLine(details: ConfirmationDetails, t: Copy): string {
  return details.paid
    ? `${t.total}: ${formatMoney(details.totalSatang, details.currency)}`
    : t.free;
}

function ticketLines(
  ticket: ConfirmationTicket,
  details: ConfirmationDetails,
  t: Copy,
): string[] {
  const label = ticket.ticketLabel ?? details.eventName;
  const holder = ticket.holderName ?? details.buyerName;
  return [
    `  ${t.ticketLine(label, holder)}`,
    `  ${t.showQr} ${ticket.qrToken}`,
  ];
}
