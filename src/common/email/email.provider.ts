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

/**
 * Abstraction over email delivery. Handlers depend on this port (DIP); the app
 * binds a concrete provider — a dev/log provider here, a real SMTP/SES provider
 * (config-selected) in production.
 */
export abstract class EmailProvider {
  abstract send(message: EmailMessage): Promise<void>;
}
