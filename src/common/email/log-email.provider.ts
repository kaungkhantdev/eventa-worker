import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from './email.provider';

/**
 * Dev email provider: records that a message was sent, instead of sending it.
 *
 * It deliberately does NOT log the body. Bodies carry single-use links, and
 * since the registration confirmation they can carry standing credentials —
 * "never log secrets/tokens" admits no debug-level exception, and LOG_LEVEL is
 * `debug` in the shipped .env. The recipient address is PII and stays at debug.
 * Swap for a real SMTP/SES provider in production.
 */
@Injectable()
export class LogEmailProvider extends EmailProvider {
  private readonly logger = new Logger('EmailProvider');

  send(message: EmailMessage): Promise<void> {
    this.logger.log({ subject: message.subject }, 'Email sent (dev provider)');
    this.logger.debug({ to: message.to }, 'Email recipient');
    return Promise.resolve();
  }
}
