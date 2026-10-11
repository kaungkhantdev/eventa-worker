import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider, logKind } from './email.provider';

/**
 * Dev email provider: records that a message was sent, instead of sending it.
 *
 * It deliberately does NOT log the body. Bodies carry single-use links, and
 * since the registration confirmation they can carry standing credentials —
 * "never log secrets/tokens" admits no debug-level exception, and LOG_LEVEL is
 * `debug` in the shipped .env. The recipient address is PII and stays at debug.
 * Nor the SUBJECT, which an organizer's merge fields now fill with the buyer's
 * name — {@link logKind} is what identifies the message instead.
 * Swap for a real SMTP/SES provider in production.
 */
@Injectable()
export class LogEmailProvider extends EmailProvider {
  private readonly logger = new Logger('EmailProvider');

  send(message: EmailMessage): Promise<void> {
    this.logger.log({ kind: logKind(message) }, 'Email sent (dev provider)');
    this.logger.debug({ to: message.to }, 'Email recipient');
    return Promise.resolve();
  }
}
