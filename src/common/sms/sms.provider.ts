import type { DeliveryContext } from '../email/email.provider';

/**
 * What a TEXT is, for the delivery log (US-MSG-06).
 *
 * Extends the email context with the one thing a text cannot supply from its
 * own fields: who the person is, by address. `message_deliveries.recipient_email`
 * is NOT NULL and the table has no phone column, so a text is filed under the
 * same person as their email and the NUMBER IS NEVER STORED. That is a
 * deliberate limit, not an oversight: an organizer can see that a text failed,
 * but not which number it failed to.
 */
export interface SmsDeliveryContext extends DeliveryContext {
  recipientEmail: string;
}

/** A single outbound text. */
export interface SmsMessage {
  /** E.164, e.g. `+66812345678` — see `toThaiMobileE164`. */
  to: string;
  text: string;
  /** Present on attendee-facing texts; see {@link SmsDeliveryContext}. */
  delivery?: SmsDeliveryContext;
}

/**
 * Abstraction over SMS delivery, beside `EmailProvider` and for the same
 * reason: handlers depend on the port, and the app binds a transport from
 * config.
 *
 * `enabled` is the one thing email has no equivalent of. There is no SMS
 * account for this product yet, so a deployment may have NO transport at all —
 * and a handler must be able to tell "nothing is configured" from "the send
 * failed", without reading config or catching an exception it would then have
 * to classify. Asking first also means a deployment with SMS off never runs
 * the database read behind the text.
 */
export abstract class SmsProvider {
  abstract readonly enabled: boolean;
  abstract send(message: SmsMessage): Promise<void>;
}

/**
 * A send an SMS transport could not complete, and whether it is worth another
 * attempt.
 *
 * `retryable` is stated by the transport rather than inferred downstream,
 * because `failure.ts` reads `code` and `responseCode` with SMTP and Postgres
 * meanings — where 5xx is PERMANENT, the exact opposite of HTTP. A transport
 * that let an HTTP status reach either field would invert its own decision, so
 * this carries the answer on a field of its own and neither of those.
 *
 * The message must never quote the number or the body: the consumer logs the
 * error, and `RecordingSmsProvider` writes its message into the delivery log.
 */
export class SmsDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SmsDeliveryError';
  }
}
