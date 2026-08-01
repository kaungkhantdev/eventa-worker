import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import {
  IDENTITY_TWO_FACTOR_DISABLED,
  type TwoFactorDisabledEvent,
  twoFactorDisabledSchema,
} from './two-factor-disabled.schema';

const SUBJECT = 'Two-factor authentication was turned off';

/**
 * Handles `identity.two_factor_disabled` (US-SET-03): tells the member their
 * second factor was removed, so a silent removal by someone holding their session
 * is still noticed.
 */
@Injectable()
export class TwoFactorDisabledHandler extends ValidatedHandler<TwoFactorDisabledEvent> {
  readonly routingKey = IDENTITY_TWO_FACTOR_DISABLED;
  protected readonly schema = twoFactorDisabledSchema;
  private readonly logger = new Logger(TwoFactorDisabledHandler.name);

  constructor(private readonly email: EmailProvider) {
    super();
  }

  protected async process(
    payload: TwoFactorDisabledEvent,
    ctx: MessageContext,
  ): Promise<void> {
    await this.email.send({
      to: payload.email,
      subject: SUBJECT,
      text: this.body(payload.name),
    });
    this.logger.log(
      { correlationId: ctx.correlationId, userId: payload.userId },
      'Sent two-factor disabled notice',
    );
  }

  private body(name: string): string {
    return [
      `Hi ${name},`,
      '',
      'Two-factor authentication was just turned off for your Eventa account.',
      '',
      "If this wasn't you, change your password immediately and turn two-factor",
      'back on — someone else may have access to your account.',
    ].join('\n');
  }
}
