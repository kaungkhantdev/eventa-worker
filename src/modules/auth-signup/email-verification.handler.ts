import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { safeDisplayName } from '../../common/messaging/display-name';
import { greeting } from '../../common/messaging/greeting';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import {
  type EmailVerificationRequestedEvent,
  IDENTITY_EMAIL_VERIFICATION_REQUESTED,
  emailVerificationRequestedSchema,
} from './email-verification.schema';

const SUBJECT = 'Confirm your email to finish signing up';

/**
 * Handles `identity.email_verification_requested`: renders and sends the sign-up
 * confirmation email (US-ACC-01) via the email provider. The link/token is supplied
 * by the API in `verifyUrl`; this handler only delivers it.
 */
@Injectable()
export class EmailVerificationHandler extends ValidatedHandler<EmailVerificationRequestedEvent> {
  readonly routingKey = IDENTITY_EMAIL_VERIFICATION_REQUESTED;
  protected readonly schema = emailVerificationRequestedSchema;
  private readonly logger = new Logger(EmailVerificationHandler.name);

  constructor(private readonly email: EmailProvider) {
    super();
  }

  protected async process(
    payload: EmailVerificationRequestedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    await this.email.send({
      to: payload.email,
      subject: SUBJECT,
      text: this.body(payload.name, payload.verifyUrl),
    });
    this.logger.log(
      { correlationId: ctx.correlationId, userId: payload.userId },
      'Sent verification email',
    );
  }

  private body(name: string, verifyUrl: string): string {
    return [
      // The account's own name, which is free text whoever holds a session can
      // set — so it goes through the SECURITY rule (`safeDisplayName`, an
      // allow-list that declines anything not shaped like a name) and not the
      // sanitising one the attendee notices use. `greeting` turns a declined
      // name into `Hi,`; see `common/messaging/inline-text.ts` for why these
      // two mails want the stricter of the two rules. The locale is fixed
      // because this copy is English only.
      greeting('en', safeDisplayName(name) ?? ''),
      '',
      'Confirm your email address to activate your Eventa workspace:',
      verifyUrl,
      '',
      'This link expires in 24 hours. If you didn’t sign up, you can ignore this email.',
    ].join('\n');
  }
}
