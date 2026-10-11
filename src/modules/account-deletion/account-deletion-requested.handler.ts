import { Injectable, Logger } from '@nestjs/common';
import { readRefinement } from '../../common/db/refinement-read';
import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import { EmailProvider } from '../../common/email/email.provider';
import { MetricsService } from '../../metrics/metrics.service';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import type { Locale } from '../../db/schema/events';
import { closureBody, closureSubject } from './account-deletion-notice';
import { AccountDeletionRepository } from './account-deletion.repository';
import {
  type AccountDeletionRequestedEvent,
  IDENTITY_ACCOUNT_DELETION_REQUESTED,
  accountDeletionRequestedSchema,
} from './account-deletion-requested.schema';

/**
 * Handles `identity.account_deletion_requested` (US-DISC-14): tells the account
 * holder that their account has been closed, what that means, and what to do if
 * it was not them.
 *
 * Four decisions worth knowing about:
 *
 * - **It is UNCONDITIONAL.** No template slug, no `templates.isActive` check —
 *   the same shape as `password-reset.handler.ts` and
 *   `two-factor-disabled.handler.ts`. This is the person's own security
 *   correspondence about their own account; an organizer must not be able to
 *   switch off the only notice that tells somebody their account is gone.
 * - **No database failure can switch it off either.** The one read it makes
 *   supplies a language and nothing else, so it cannot stop the send — see
 *   {@link localeFor}. An organizer cannot silence this notice and neither can
 *   a thirty-second outage.
 * - **It is not in the organizer's delivery log.** The send carries no
 *   `delivery` context, so `RecordingEmailProvider` files no row — see its
 *   docstring: account mail under a workspace's message log would show
 *   colleagues somebody's personal mail.
 * - **Redelivery sends nothing twice.** `ConsumerService` dedupes on the
 *   *completed* message id, so a single-recipient handler needs no ledger of
 *   its own; the fan-out handlers carry one because they can be interrupted
 *   part-way through a list, and this cannot.
 */
@Injectable()
export class AccountDeletionRequestedHandler extends ValidatedHandler<AccountDeletionRequestedEvent> {
  readonly routingKey = IDENTITY_ACCOUNT_DELETION_REQUESTED;
  protected readonly schema = accountDeletionRequestedSchema;
  private readonly logger = new Logger(AccountDeletionRequestedHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly accounts: AccountDeletionRepository,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  protected async process(
    payload: AccountDeletionRequestedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const notice = {
      locale: await this.localeFor(payload, ctx),
      name: payload.name,
      deletedAt: new Date(payload.occurredAt),
    };
    await this.email.send({
      to: payload.email,
      subject: closureSubject(notice),
      text: closureBody(notice),
    });
    this.logger.log(
      { correlationId: ctx.correlationId, userId: payload.userId },
      'Sent account-closure notice',
    );
  }

  /**
   * The closed account's language, or {@link DEFAULT_LOCALE} when the database
   * cannot be asked — for ANY reason, which is the point.
   *
   * The lookup chooses WHICH language. It decides nothing about whether the
   * notice is true or where it goes, because the address and every word of the
   * copy are already on the message — and the address is on the message
   * precisely because the row it came from is the one scheduled to be scrubbed.
   * It is a refinement, and `common/db/refinement-read.ts` holds the rule for
   * those: this method cannot fail. A failure that reached the send would nack
   * the message into the dead-letter queue, and the one notice telling somebody
   * their account is gone, and what to do if it was not them, would never
   * arrive.
   *
   * It deliberately does NOT classify the failure. A broken query is a fault to
   * fix and a refused connection is not, but the only lever a guard here could
   * pull is whether to withhold the notice — and withholding is wrong for both.
   * Being loud is {@link noteDegradedLocale}'s job instead.
   */
  private localeFor(
    payload: AccountDeletionRequestedEvent,
    ctx: MessageContext,
  ): Promise<Locale> {
    return readRefinement(
      () => this.accounts.noticeLocale(payload.organizationId, payload.userId),
      DEFAULT_LOCALE,
      (code) => this.noteDegradedLocale(payload, ctx, code),
    );
  }

  /**
   * The whole of "be loud" about a language lookup that failed: a warn line and
   * a counter, neither of which can cost anybody their notice.
   *
   * The line carries ids and the failure's own code only — never the recipient
   * address or the name, and never the error itself, which a node-postgres
   * rejection can hang more than the bound ids off.
   */
  private noteDegradedLocale(
    payload: AccountDeletionRequestedEvent,
    ctx: MessageContext,
    code: string | null,
  ): void {
    this.metrics.recordDegradedSend(this.routingKey, 'locale');
    this.logger.warn(
      { correlationId: ctx.correlationId, userId: payload.userId, code },
      'Could not read the account language — writing the closure notice in English rather than not at all',
    );
  }
}
