import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import {
  IDENTITY_PASSWORD_RESET_REQUESTED,
  type PasswordResetRequestedEvent,
  passwordResetRequestedSchema,
} from './password-reset.schema';

const SUBJECT = 'Reset your Eventa password';

/**
 * Which workspace the link opens. One address can hold an organizer account in
 * several workspaces and gets one email per account (US-ACC-04); without this
 * the emails are identical and only one of them opens the workspace wanted.
 */
function forWorkspace(workspaceName: string | undefined): string {
  return workspaceName ? ` for the “${workspaceName}” workspace` : '';
}

/**
 * Handles `identity.password_reset_requested`: sends the reset email carrying the
 * single-use link (US-ACC-04). The link/token is supplied by the API; this handler
 * only delivers it.
 */
@Injectable()
export class PasswordResetHandler extends ValidatedHandler<PasswordResetRequestedEvent> {
  readonly routingKey = IDENTITY_PASSWORD_RESET_REQUESTED;
  protected readonly schema = passwordResetRequestedSchema;
  private readonly logger = new Logger(PasswordResetHandler.name);

  constructor(private readonly email: EmailProvider) {
    super();
  }

  protected async process(
    payload: PasswordResetRequestedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    await this.email.send({
      to: payload.email,
      subject: SUBJECT,
      text: this.body(payload),
    });
    this.logger.log(
      { correlationId: ctx.correlationId, userId: payload.userId },
      'Sent password-reset email',
    );
  }

  private body({
    name,
    workspaceName,
    resetUrl,
  }: PasswordResetRequestedEvent): string {
    return [
      `Hi ${name},`,
      '',
      `We received a request to reset your Eventa password${forWorkspace(workspaceName)}. Set a new one here:`,
      resetUrl,
      '',
      'This link expires in 1 hour and can be used once. If you didn’t ask for this, you can ignore this email.',
    ].join('\n');
  }
}
