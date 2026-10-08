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
 * EVENTA'S OWN WORDING, FOR NOW. `message_templates` does have `sms_body_en`
 * and `sms_body_th` — they have existed since migration 0028 — but nothing
 * writes them and nothing reads them yet, so this built-in copy is what an
 * attendee gets. The organizer's rewording (US-MSG-02) reaches the EMAIL only.
 * Wiring those columns up is a deliberate later step, not a missing migration;
 * the API catalog's description says a text goes in Eventa's words today,
 * because an organizer who rewords the confirmation and then reads their
 * attendee's text deserves to have been told.
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
 *
 * Counted and cut by CODE POINT, not by `string.length`. An emoji straddling
 * the boundary would otherwise be cut between its surrogates, and the lone
 * half does not survive the trip: the Twilio transport builds its request body
 * with `URLSearchParams`, which serialises an unpaired surrogate as U+FFFD —
 * so the attendee reads a replacement character. Counting the same way also
 * keeps the bound honest, since one emoji is one character to a reader and to
 * the segment count, whatever its code units say.
 */
function clip(eventName: string): string {
  const chars = [...eventName];
  if (chars.length <= MAX_EVENT_NAME_CHARS) return eventName;
  return `${chars.slice(0, MAX_EVENT_NAME_CHARS).join('')}${ELLIPSIS}`;
}
