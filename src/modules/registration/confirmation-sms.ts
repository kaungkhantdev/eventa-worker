import type { Locale } from '../../db/schema/events';

/**
 * The confirmation TEXT (US-DISC-06 AC5) — the short companion to the
 * confirmation email, for an attendee who gave a mobile number.
 *
 * Three things it carries and nothing else: which event, the booking
 * reference, and the link that renders the QR. A text is not a second email;
 * everything the email says about time, place and price is in the email, and a
 * text that repeated it would cost several segments to say less clearly.
 *
 * ALWAYS EVENTA'S OWN WORDING. The organizer's rewording (US-MSG-02) is
 * email-only: `message_templates` stores `email_subject_*` and `email_body_*`
 * and nothing writes an SMS body, so there is none to read. The API catalog's
 * description says so, because an organizer who rewords the confirmation and
 * then reads a text in Eventa's words deserves to have been told.
 */

/** One language's text. Declared so EN and TH must stay the same shape. */
type SmsCopy = (event: string, reference: string, url: string) => string;

/**
 * How much of an event's name a text will carry.
 *
 * Cost, not tidiness. A Thai text is UCS-2 at 70 characters per segment (67
 * once it splits), and an English one holds 160 only while every character is
 * GSM-7 — which an organizer's event name has no obligation to be. Bounding
 * the one field Eventa does not write bounds the bill.
 */
const MAX_EVENT_NAME_CHARS = 40;

/** ASCII, deliberately: '…' is not GSM-7 and would double the cost. */
const ELLIPSIS = '...';

/**
 * The English copy is PURE GSM-7 — note the ASCII apostrophe in "you're". One
 * typographic quote here would move every English confirmation to UCS-2, at 70
 * characters a segment instead of 160, for every attendee.
 */
const COPY: Record<Locale, SmsCopy> = {
  en: (event, reference, url) =>
    `Eventa: you're registered for ${event}. Ref ${reference}. Your tickets: ${url}`,
  th: (event, reference, url) =>
    `Eventa: ลงทะเบียน ${event} เรียบร้อยแล้ว รหัสการจอง ${reference} ดูบัตรของคุณ: ${url}`,
};

export interface ConfirmationSmsDetails {
  locale: Locale;
  eventName: string;
  reference: string;
  /** ABSOLUTE link to the page that renders the scannable codes. */
  ticketsUrl: string;
}

export function confirmationSms(details: ConfirmationSmsDetails): string {
  return COPY[details.locale](
    clip(details.eventName),
    details.reference,
    details.ticketsUrl,
  );
}

/**
 * The event name is the only value clipped. The reference and the link are
 * what the attendee needs to act on, and half of either is worse than none.
 */
function clip(eventName: string): string {
  if (eventName.length <= MAX_EVENT_NAME_CHARS) return eventName;
  return `${eventName.slice(0, MAX_EVENT_NAME_CHARS)}${ELLIPSIS}`;
}
