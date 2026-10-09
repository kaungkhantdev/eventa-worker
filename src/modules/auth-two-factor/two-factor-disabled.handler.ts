import { Injectable, Logger } from '@nestjs/common';
import { readRefinement } from '../../common/db/refinement-read';
import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import { EmailProvider } from '../../common/email/email.provider';
import type { Locale } from '../../db/schema/events';
import { MetricsService } from '../../metrics/metrics.service';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { AuthTwoFactorRepository } from './auth-two-factor.repository';
import {
  twoFactorDisabledBody,
  twoFactorDisabledSubject,
} from './two-factor-disabled.notice';
import {
  IDENTITY_TWO_FACTOR_DISABLED,
  type TwoFactorDisabledEvent,
  twoFactorDisabledSchema,
} from './two-factor-disabled.schema';

/**
 * Handles `identity.two_factor_disabled` (US-SET-03): alerts the account holder
 * that their second factor was removed, so a silent removal by somebody holding
 * their session is still noticed.
 *
 * Unconditional, like the password reset and the signup verification it sits
 * beside: identity mail is the person's own security correspondence, not the
 * workspace's marketing, so there is no template slug, no `templates.isActive`
 * check and no catalog entry to add. Unconditional on the DATABASE too: the one
 * read it makes supplies a language and nothing else, so no database failure of
 * any kind can stop the alert — see {@link localeFor}. Before this handler read
 * anything at all the alert always went out, and adding a read must not have
 * quietly changed that.
 *
 * Idempotency is NOT handled here, on purpose. `ConsumerService` dedupes on the
 * completed message id before dispatch and records completion only after this
 * handler returns, so a redelivery of the same message sends no second email
 * and an interrupted run is re-processed rather than skipped. A second
 * mechanism inside the handler would duplicate that and could only disagree
 * with it. The per-recipient `recipientLedger` is for fan-outs; this message
 * has exactly one recipient.
 */
@Injectable()
export class TwoFactorDisabledHandler extends ValidatedHandler<TwoFactorDisabledEvent> {
  readonly routingKey = IDENTITY_TWO_FACTOR_DISABLED;
  protected readonly schema = twoFactorDisabledSchema;
  private readonly logger = new Logger(TwoFactorDisabledHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly accounts: AuthTwoFactorRepository,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  protected async process(
    payload: TwoFactorDisabledEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const notice = {
      name: payload.name,
      locale: await this.localeFor(payload, ctx),
      occurredAt: new Date(payload.occurredAt),
    };
    await this.email.send({
      to: payload.email,
      subject: twoFactorDisabledSubject(notice),
      text: twoFactorDisabledBody(notice),
      // No `delivery` context, so RecordingEmailProvider files no row. The
      // delivery log is the ORGANIZER's record of mail sent to their attendees
      // (US-MSG-06); a member's own security alert filed under the workspace
      // would show their personal account mail to colleagues who have no
      // business reading it.
    });
    // The recipient address is deliberately absent: it is the account holder's
    // personal email, and a security alert's log line is not the place to copy
    // somebody's PII. The user id identifies the account for support.
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        userId: payload.userId,
        locale: notice.locale,
      },
      'Sent two-factor disabled notice',
    );
  }

  /**
   * The account holder's language, or {@link DEFAULT_LOCALE} when the database
   * cannot be asked — for ANY reason, which is the point.
   *
   * The lookup chooses WHICH language. It decides nothing about whether the
   * alert is true or where it goes, because the address and every word of the
   * copy are already on the message: it is a refinement, and
   * `common/db/refinement-read.ts` holds the rule for those. So this method
   * cannot fail. A failure that reached the send would nack the message, burn
   * the retry ladder and park it in the dead-letter queue, and the person whose
   * second factor was just removed would be told nothing at all.
   *
   * It deliberately does NOT classify the failure. A broken query is a fault to
   * fix and a refused connection is not, but the only lever a guard here could
   * pull is whether to withhold the alert — and withholding is wrong for both.
   * An English alert that arrives beats a perfectly-localised one that does not
   * exist. Being loud is {@link noteDegradedLocale}'s job instead.
   */
  private localeFor(
    payload: TwoFactorDisabledEvent,
    ctx: MessageContext,
  ): Promise<Locale> {
    return readRefinement(
      () => this.accounts.accountLocale(payload.organizationId, payload.userId),
      DEFAULT_LOCALE,
      (code) => this.noteDegradedLocale(payload, ctx, code),
    );
  }

  /**
   * The whole of "be loud" about a language lookup that failed: a warn line and
   * a counter, neither of which can cost anybody their alert.
   *
   * The line carries ids and the failure's own code only — never the recipient
   * address or the name, which are the account holder's PII and have no
   * business in a log, and never the error itself, which a node-postgres
   * rejection can hang more than the bound ids off.
   */
  private noteDegradedLocale(
    payload: TwoFactorDisabledEvent,
    ctx: MessageContext,
    code: string | null,
  ): void {
    this.metrics.recordDegradedSend(this.routingKey, 'locale');
    this.logger.warn(
      { correlationId: ctx.correlationId, userId: payload.userId, code },
      'Could not read the account language — alerting in English rather than not at all',
    );
  }
}
