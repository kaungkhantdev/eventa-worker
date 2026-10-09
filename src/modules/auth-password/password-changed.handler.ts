import { Injectable, Logger } from '@nestjs/common';
import { readRefinement } from '../../common/db/refinement-read';
import { EmailProvider } from '../../common/email/email.provider';
import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import type { Locale } from '../../db/schema/events';
import { MetricsService } from '../../metrics/metrics.service';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { AuthPasswordRepository } from './auth-password.repository';
import {
  passwordChangedBody,
  passwordChangedSubject,
} from './password-changed.notice';
import {
  IDENTITY_PASSWORD_CHANGED,
  type PasswordChangedEvent,
  passwordChangedSchema,
} from './password-changed.schema';

/**
 * Handles `identity.password_changed` (US-ACC-05 / US-DISC-12 criterion 4):
 * tells the account holder their password was changed, so a change made by
 * somebody holding their session is still noticed. A password change nobody is
 * told about is how a stolen session becomes a permanent one.
 *
 * Unconditional, like the reset mail beside it and the two-factor alert it is
 * the closest sibling of: identity mail is the person's own security
 * correspondence, not the workspace's marketing, so there is no template slug,
 * no `templates.isActive` check and no catalog entry to add. Unconditional on
 * the DATABASE too: the one read it makes supplies a language and nothing else,
 * so no database failure of any kind can stop the notice — see
 * {@link localeFor}.
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
export class PasswordChangedHandler extends ValidatedHandler<PasswordChangedEvent> {
  readonly routingKey = IDENTITY_PASSWORD_CHANGED;
  protected readonly schema = passwordChangedSchema;
  private readonly logger = new Logger(PasswordChangedHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly accounts: AuthPasswordRepository,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  protected async process(
    payload: PasswordChangedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const notice = {
      name: payload.name,
      locale: await this.localeFor(payload, ctx),
      occurredAt: new Date(payload.occurredAt),
      otherSessionsSignedOut: payload.otherSessionsSignedOut,
    };
    await this.email.send({
      to: payload.email,
      subject: passwordChangedSubject(notice),
      text: passwordChangedBody(notice),
      // No `delivery` context, so RecordingEmailProvider files no row. The
      // delivery log is the ORGANIZER's record of mail sent to their attendees
      // (US-MSG-06); a member's own security notice filed under the workspace
      // would show their personal account mail to colleagues who have no
      // business reading it.
    });
    // Neither the recipient address nor the name is logged, here or in
    // `noteDegradedLocale`: they are the account holder's PII, and a security
    // notice's log line is not the place to copy somebody's mailbox or the
    // name on their profile. The user id identifies the account for support.
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        userId: payload.userId,
        locale: notice.locale,
      },
      'Sent password-changed notice',
    );
  }

  /**
   * The account holder's language, or {@link DEFAULT_LOCALE} when the database
   * cannot be asked — for ANY reason, which is the point.
   *
   * The lookup chooses WHICH language. It decides nothing about whether the
   * notice is true or where it goes, because the address and every word of the
   * copy are already on the message: it is a refinement, and
   * `common/db/refinement-read.ts` holds the rule for those. So this method
   * cannot fail. A failure that reached the send would nack the message, burn
   * the retry ladder and park it in the dead-letter queue, and the person whose
   * password was just changed without their doing would be told nothing at all.
   *
   * It deliberately does NOT classify the failure. A broken query is a fault to
   * fix and a refused connection is not, but the only lever a guard here could
   * pull is whether to withhold the notice — and withholding is wrong for both.
   * An English notice that arrives beats a perfectly-localised one that does
   * not exist. Being loud is {@link noteDegradedLocale}'s job instead.
   */
  private localeFor(
    payload: PasswordChangedEvent,
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
   * a counter, neither of which can cost anybody their notice.
   *
   * The line carries ids and the failure's own code only — never the recipient
   * address or the name, which are the account holder's PII and have no
   * business in a log, and never the error itself, which a node-postgres
   * rejection can hang more than the bound ids off.
   */
  private noteDegradedLocale(
    payload: PasswordChangedEvent,
    ctx: MessageContext,
    code: string | null,
  ): void {
    this.metrics.recordDegradedSend(this.routingKey, 'locale');
    this.logger.warn(
      { correlationId: ctx.correlationId, userId: payload.userId, code },
      'Could not read the account language — writing in English rather than not at all',
    );
  }
}
