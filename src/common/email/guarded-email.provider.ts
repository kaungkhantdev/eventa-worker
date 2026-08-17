import { Injectable, Logger } from '@nestjs/common';
import { isDeliverable } from './email-allowlist';
import { EmailMessage, EmailProvider } from './email.provider';

/**
 * Refuses to mail anyone outside `EMAIL_ALLOWLIST` when not in production.
 *
 * A decorator rather than a branch inside the SMTP provider: transport and
 * policy are two jobs, and wrapping means the guard applies whichever provider
 * is configured. Handlers still depend on the `EmailProvider` port and cannot
 * tell the difference — which is the point, because a handler that had to
 * remember to check would eventually forget.
 *
 * Why this exists: verifying delivery really works means pointing a dev box at
 * a real SMTP provider, and the database is full of seeded addresses that look
 * real. Without this, one `confirm` mails a stranger.
 */
@Injectable()
export class GuardedEmailProvider extends EmailProvider {
  private readonly logger = new Logger('EmailProvider');

  constructor(
    private readonly inner: EmailProvider,
    private readonly allowlist: string[],
    private readonly isProduction: boolean,
  ) {
    super();
  }

  async send(message: EmailMessage): Promise<void> {
    if (!isDeliverable(message.to, this.allowlist, this.isProduction)) {
      // Warn, not error: nothing is broken, and this is the guard doing its
      // job. Loud enough that "why did no email arrive?" is answered by the
      // logs rather than by an afternoon. The subject is safe to log; the
      // recipient is PII and stays at debug, as everywhere else here.
      this.logger.warn(
        { subject: message.subject },
        'Email suppressed — recipient not in EMAIL_ALLOWLIST',
      );
      this.logger.debug({ to: message.to }, 'Suppressed recipient');
      // Resolve rather than throw. Throwing would nack, retry and dead-letter
      // a message the guard deliberately refused — filling the DLQ with
      // evidence that it worked.
      return;
    }
    await this.inner.send(message);
  }
}
