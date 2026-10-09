import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { fill, pickWording } from '../../common/messaging/merge-fields';
import { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import { REJECTION_NOTICE_SLUG } from '../../db/schema/messaging';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { EventRecipientsRepository } from '../events/event-recipients.repository';
import { readerLocale } from '../events/reader-locale';
import {
  moneyOf,
  rejectionBody,
  rejectionSubject,
  type RejectionNotice,
} from './rejection-notice';
import {
  REGISTRATION_REJECTED,
  type RegistrationRejectedEvent,
  registrationRejectedSchema,
} from './registration-rejected.schema';
import {
  RegistrationRepository,
  type RejectionSource,
} from './registration.repository';

/**
 * Handles `registration.rejected` (US-REG-02): an organizer turned a sign-up
 * down, and the person who signed up is told so — "a rejection notice is
 * emailed to the attendee".
 *
 * Until this existed the key reached the topic exchange with nothing bound to
 * it. A topic exchange DISCARDS such a message: it does not fail, does not
 * retry and does not reach the dead-letter queue, so every rejection since the
 * API started publishing them was an attendee who heard nothing and a silence
 * with no trace of itself anywhere. `app.module.spec.ts` exists because the
 * same thing happened to `payment.refund_required`.
 *
 * What shapes it:
 *
 * - **The organizer can switch it off** (`message_templates.active`), because
 *   this is attendee mail the WORKSPACE sends, not identity mail somebody is
 *   owed by Eventa — the split that keeps `password-reset` unconditional. An
 *   absent row means on, so a workspace that never opened its message settings
 *   still tells people. The switch is read BEFORE the order, so a message that
 *   will not be sent pulls nobody's name or money out of the database.
 * - **The order is read at send time**, for the event's name and for what
 *   became of the money. eventa-api commits the rejection and only then
 *   attempts the refund, so the same rejection can be read while the payment is
 *   still captured or after it has gone back; `moneyOf` picks the line that is
 *   true now. An order that is no longer there is not an error — nothing is
 *   sent, and the message is done.
 * - **Language follows the person**: their own account's, then the event's,
 *   then the workspace's, then English — the same precedence as their
 *   confirmation, so nobody is registered in Thai and refused in English.
 * - **The organizer's note never reaches the attendee.** See
 *   `rejection-notice.ts`: the payload's `reason` is the organizer's audit
 *   trail, and the notice is written for the no-reason case because that is the
 *   only case it has.
 *
 * Idempotent on the message id, recorded only after the send — a redelivery
 * after a crash mid-send re-sends rather than silently skipping, which for one
 * email is the right way round.
 */
@Injectable()
export class RegistrationRejectedHandler extends ValidatedHandler<RegistrationRejectedEvent> {
  readonly routingKey = REGISTRATION_REJECTED;
  protected readonly schema = registrationRejectedSchema;
  private readonly logger = new Logger(RegistrationRejectedHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly repo: RegistrationRepository,
    private readonly templates: MessageTemplatesRepository,
    private readonly recipients: EventRecipientsRepository,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  protected async process(
    payload: RegistrationRejectedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    if (ctx.messageId && (await this.idempotency.isCompleted(ctx.messageId))) {
      return;
    }
    const source = await this.sendable(payload, ctx);
    if (source) await this.send(payload, source, ctx);
    if (ctx.messageId) await this.idempotency.markCompleted(ctx.messageId);
  }

  /** The order to write about, or null with the reason logged. */
  private async sendable(
    payload: RegistrationRejectedEvent,
    ctx: MessageContext,
  ): Promise<RejectionSource | null> {
    const note = (message: string): null => {
      this.logger.log(
        { correlationId: ctx.correlationId, orderId: payload.orderId },
        message,
      );
      return null;
    };
    const on = await this.templates.isActive(
      payload.organizationId,
      REJECTION_NOTICE_SLUG,
    );
    if (!on) {
      return note('The rejection notice is switched off for this workspace');
    }
    const source = await this.repo.loadRejection(
      payload.organizationId,
      payload.orderId,
    );
    return source ?? note('No such order — no rejection notice sent');
  }

  private async send(
    payload: RegistrationRejectedEvent,
    source: RejectionSource,
    ctx: MessageContext,
  ): Promise<void> {
    const notice = await this.compose(payload, source);
    await this.email.send({
      to: payload.buyerEmail,
      subject: rejectionSubject(notice),
      text: rejectionBody(notice),
      delivery: {
        organizationId: payload.organizationId,
        kind: REJECTION_NOTICE_SLUG,
        recipientName: payload.buyerName,
        eventId: payload.eventId,
      },
    });
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        orderId: payload.orderId,
        eventId: payload.eventId,
        locale: notice.locale,
        // The OUTCOME, not the amount — this line says what the attendee was
        // told about their money without putting their money in the log.
        money: notice.money,
      },
      'Sent rejection notice',
    );
  }

  private async compose(
    payload: RegistrationRejectedEvent,
    source: RejectionSource,
  ): Promise<RejectionNotice> {
    const locale = await readerLocale(this.recipients, {
      organizationId: payload.organizationId,
      eventId: payload.eventId,
      email: payload.buyerEmail,
    });
    const chosen = pickWording(
      await this.templates.wordingFor(
        payload.organizationId,
        REJECTION_NOTICE_SLUG,
      ),
      locale,
    );
    const fields = {
      first_name: payload.buyerName,
      event_name: source.eventName,
    };
    return {
      locale,
      attendeeName: payload.buyerName,
      eventName: source.eventName,
      reference: payload.reference,
      money: moneyOf(source),
      totalSatang: source.totalSatang,
      currency: source.currency,
      subject: chosen.subject && fill(chosen.subject, fields),
      opening: chosen.body && fill(chosen.body, fields),
    };
  }
}
