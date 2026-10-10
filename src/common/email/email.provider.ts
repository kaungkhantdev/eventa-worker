/**
 * What a message is, for the delivery log (US-MSG-06).
 *
 * Carried on the message rather than passed separately so the context travels
 * with the thing it describes: a handler that builds a message has everything
 * needed to log it, and cannot hand the recorder the wrong recipient.
 *
 * Absent on account mail — a password reset is not the organizer's message log.
 */
export interface DeliveryContext {
  organizationId: number;
  /** The catalog slug for an automated message, or `announcement`. */
  kind: string;
  recipientName?: string;
  /** The event it is about, where there is one. */
  eventId?: string;
}

/** A single outbound email. Plain-text for now; a real provider may add html/from. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Present on attendee-facing mail; see {@link DeliveryContext}. */
  delivery?: DeliveryContext;
}

/** What account mail is called in a log line, having no delivery context. */
const ACCOUNT_MAIL = 'account';

/**
 * The one thing about a message a provider may safely write to a log.
 *
 * NOT the subject. A subject used to be Eventa's own copy plus an event name,
 * and both providers logged it on that basis — the SMTP one under the comment
 * "The subject is safe to log". It no longer is: `fill()` substitutes an
 * organizer's merge fields into their template and the same filled string
 * becomes the subject, so `Hi {{first_name}}, your ticket` puts a buyer's real
 * name in it. See `messaging/merge-fields.ts`.
 *
 * `kind` is the catalog slug — WHICH kind of mail went out. It is chosen from
 * a fixed catalog rather than typed by anyone, so it cannot carry personal
 * data, and it is a better handle than the subject ever was: subjects are
 * per-organizer prose that differ between two sends of the same message, while
 * a slug groups them.
 *
 * Here rather than in each provider because there are three of them and a
 * fourth promised (SES), and "remember not to log the subject" is a rule the
 * next one can be written without.
 */
export function logKind(message: EmailMessage): string {
  return message.delivery?.kind ?? ACCOUNT_MAIL;
}

/**
 * Abstraction over email delivery. Handlers depend on this port (DIP); the app
 * binds a concrete provider — a dev/log provider here, a real SMTP/SES provider
 * (config-selected) in production.
 */
export abstract class EmailProvider {
  abstract send(message: EmailMessage): Promise<void>;
}
