import { Injectable, Logger } from '@nestjs/common';
import { readRefinement } from '../../common/db/refinement-read';
import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import { SmsProvider } from '../../common/sms/sms.provider';
import { toThaiMobileE164 } from '../../common/sms/thai-mobile';
import type { Locale } from '../../db/schema/events';
import { MetricsService } from '../../metrics/metrics.service';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { phoneVerificationSms } from './phone-verification-sms';
import {
  IDENTITY_PHONE_VERIFICATION_REQUESTED,
  type PhoneVerificationRequestedEvent,
  phoneVerificationRequestedSchema,
} from './phone-verification.schema';
import { UsersRepository } from './users.repository';

/**
 * Handles `identity.phone_verification_requested` (US-DISC-11 AC3): texts the
 * code that confirms a changed phone number to the REQUESTED number. eventa-api
 * holds that number aside until the code is typed back, so without this text
 * a new number can never be confirmed and nothing is ever texted to it.
 *
 * Unconditional, like the other identity messages here: no template slug and
 * no `delivery` context, because a member's own account text is not the
 * workspace's correspondence and does not belong in its delivery log.
 *
 * Its one read supplies a language and nothing else, so no failure of it can
 * withhold the code — see {@link localeFor}.
 *
 * A failed SEND is not handled here at all. The transport says on
 * `SmsDeliveryError.retryable` whether another attempt can help, and
 * `rabbitmq/failure.ts` believes it: an outage rides the retry ladder, a final
 * refusal parks in the dead-letter queue at once. Swallowing either would
 * complete the message and the member would never get a code.
 *
 * Idempotency is `ConsumerService`'s: it records the message id as completed
 * only after this returns, and there is one recipient, so no ledger here.
 *
 * NEITHER THE NUMBER NOR THE CODE MAY REACH A LOG. The number is personal data
 * and the code is the whole credential; every log line carries ids alone.
 */
@Injectable()
export class PhoneVerificationHandler extends ValidatedHandler<PhoneVerificationRequestedEvent> {
  readonly routingKey = IDENTITY_PHONE_VERIFICATION_REQUESTED;
  protected readonly schema = phoneVerificationRequestedSchema;
  private readonly logger = new Logger(PhoneVerificationHandler.name);

  constructor(
    private readonly sms: SmsProvider,
    private readonly accounts: UsersRepository,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  protected async process(
    payload: PhoneVerificationRequestedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const to = this.recipient(payload, ctx);
    if (!to) return;
    const locale = await this.localeFor(payload, ctx);
    await this.sms.send({
      to,
      text: phoneVerificationSms({
        locale,
        code: payload.code,
        expiresAt: new Date(payload.expiresAt),
      }),
    });
    this.logger.log(
      { correlationId: ctx.correlationId, userId: payload.userId, locale },
      'Texted the code that confirms a new phone number',
    );
  }

  /**
   * The number to text, or null with the reason logged. Cheapest first: a
   * deployment with no SMS transport asks the database nothing.
   *
   * eventa-api only accepts a Thai mobile, so the second refusal should never
   * fire; it is here because a number is paid to text, and this is the gate
   * every text from this service passes.
   */
  private recipient(
    payload: PhoneVerificationRequestedEvent,
    ctx: MessageContext,
  ): string | null {
    const skip = (message: string): null => {
      this.logger.warn(
        { correlationId: ctx.correlationId, userId: payload.userId },
        message,
      );
      return null;
    };
    if (!this.sms.enabled) {
      return skip('SMS is not configured — the phone code was not texted');
    }
    return (
      toThaiMobileE164(payload.phone) ??
      skip('Not a Thai mobile — the phone code was not texted')
    );
  }

  /**
   * The member's language, or {@link DEFAULT_LOCALE} when it cannot be read —
   * for any reason. The number and every word of the text are on the message;
   * the read only chooses which language, so it is a refinement and
   * `common/db/refinement-read.ts` holds the rule: degrade, count it, send.
   */
  private localeFor(
    payload: PhoneVerificationRequestedEvent,
    ctx: MessageContext,
  ): Promise<Locale> {
    return readRefinement(
      () => this.accounts.accountLocale(payload.organizationId, payload.userId),
      DEFAULT_LOCALE,
      (code) => {
        this.metrics.recordDegradedSend(this.routingKey, 'locale');
        this.logger.warn(
          { correlationId: ctx.correlationId, userId: payload.userId, code },
          'Could not read the member’s language — texting the code in English',
        );
      },
    );
  }
}
