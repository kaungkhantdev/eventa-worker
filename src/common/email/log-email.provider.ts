import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from './email.provider';

/**
 * Dev email provider: records the message to the log instead of sending. The
 * recipient address (PII) and the body (which can carry a confirmation link/token)
 * are only logged at debug, so neither lands in info-level logs — important once a
 * broadcast fans out to hundreds of attendee addresses. Swap for a real SMTP/SES
 * provider in production.
 */
@Injectable()
export class LogEmailProvider extends EmailProvider {
  private readonly logger = new Logger('EmailProvider');

  send(message: EmailMessage): Promise<void> {
    this.logger.log({ subject: message.subject }, 'Email sent (dev provider)');
    this.logger.debug({ to: message.to, body: message.text }, 'Email body');
    return Promise.resolve();
  }
}
