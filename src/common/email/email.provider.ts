/** A single outbound email. Plain-text for now; a real provider may add html/from. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Abstraction over email delivery. Handlers depend on this port (DIP); the app
 * binds a concrete provider — a dev/log provider here, a real SMTP/SES provider
 * (config-selected) in production.
 */
export abstract class EmailProvider {
  abstract send(message: EmailMessage): Promise<void>;
}
