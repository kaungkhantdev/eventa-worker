import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import type { Env } from '../../config/env.validation';
import { EmailMessage, EmailProvider, logKind } from './email.provider';

/**
 * Real delivery over SMTP.
 *
 * One long-lived pooled transport rather than a connection per message: the
 * worker sends in bursts as the outbox drains, and re-handshaking TLS for each
 * one is both slow and the fastest way to be rate-limited by a real provider.
 *
 * Nothing here logs a body. Bodies carry single-use links and, since the
 * registration confirmation, standing credentials — "never log secrets" admits
 * no debug-level exception. A failure is rethrown rather than swallowed so the
 * message is nacked and retried; reporting success for mail that never left
 * would be worse than the outage itself.
 */
@Injectable()
export class SmtpEmailProvider
  extends EmailProvider
  implements OnModuleDestroy
{
  private readonly logger = new Logger('EmailProvider');
  // Typed with the pool's own info shape: the bare `Transporter` is generic
  // and falls back to `any`, which would make `messageId` unchecked.
  private readonly transport: Transporter<SMTPPool.SentMessageInfo>;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    const user = config.get('SMTP_USER', { infer: true });
    const pass = config.get('SMTP_PASSWORD', { infer: true });
    this.from = config.get('EMAIL_FROM', { infer: true });
    this.transport = createTransport({
      host: config.getOrThrow('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      secure: config.get('SMTP_SECURE', { infer: true }),
      // Mailpit and most dev catchers take no credentials at all; passing an
      // empty auth block makes them refuse the connection.
      ...(user ? { auth: { user, pass } } : {}),
      pool: true,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    const sent = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    // The provider's own id — what a bounce is traced by — and the message's
    // kind. NOT the subject: it used to be Eventa's own copy, but an
    // organizer's merge fields are filled into it, so it can carry the buyer's
    // name (see {@link logKind}). Nothing is lost by dropping it, because the
    // id is what a bounce is looked up by. The recipient is PII, at debug.
    this.logger.log(
      { kind: logKind(message), messageId: sent.messageId },
      'Email sent',
    );
    this.logger.debug({ to: message.to }, 'Email recipient');
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
