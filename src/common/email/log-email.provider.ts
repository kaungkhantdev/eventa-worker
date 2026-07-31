import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from './email.provider';

/**
 * Dev email provider: records the message to the log instead of sending. The body
 * (which can contain a confirmation link/token) is only logged at debug so it never
 * lands in info-level logs. Swap for a real SMTP/SES provider in production.
 */
@Injectable()
export class LogEmailProvider extends EmailProvider {
  private readonly logger = new Logger('EmailProvider');

  send(message: EmailMessage): Promise<void> {
    this.logger.log(
      { to: message.to, subject: message.subject },
      'Email sent (dev provider)',
    );
    this.logger.debug({ to: message.to, body: message.text }, 'Email body');
    return Promise.resolve();
  }
}
