import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { PaymentsRepository, type RefundContext } from './payments.repository';
import {
  type RefundNotice,
  buyerBody,
  buyerSubject,
  organizerBody,
  organizerSubject,
} from './refund-notice';
import {
  PAYMENT_REFUND_REQUIRED,
  type RefundRequiredEvent,
  refundRequiredSchema,
} from './refund-required.schema';

const DEFAULT_CURRENCY = 'THB';

/**
 * Handles `payment.refund_required` — money that arrived for a registration
 * that could not be honoured: a settlement race the buyer lost, or a second
 * payment on an order another payment already settled.
 *
 * It does NOT issue the refund. Moving money is synchronous, provider-facing
 * work that belongs in eventa-api, and `refunds.issued_by` requires a real
 * user — a refund is an organizer action (US-FIN-02). What this handler owns is
 * making sure the obligation reaches people: the organizer gets an action item,
 * the buyer gets told their money is coming back.
 *
 * Until this existed the event was published to an exchange with no consumer
 * bound, so the worker logged "No handler — dropping" and a double-charged
 * buyer's refund silently evaporated.
 *
 * A workspace with no contact address THROWS rather than returning quietly:
 * having nobody to alert is precisely the case where the money goes missing,
 * so it belongs in the dead-letter queue where someone will see it.
 */
@Injectable()
export class RefundRequiredHandler extends ValidatedHandler<RefundRequiredEvent> {
  readonly routingKey = PAYMENT_REFUND_REQUIRED;
  protected readonly schema = refundRequiredSchema;
  private readonly logger = new Logger(RefundRequiredHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly repo: PaymentsRepository,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  protected async process(
    payload: RefundRequiredEvent,
    ctx: MessageContext,
  ): Promise<void> {
    if (ctx.messageId && (await this.idempotency.isCompleted(ctx.messageId))) {
      return;
    }
    const context = await this.requireContext(payload);
    const notice = this.notice(payload, context);
    await this.alertOrganizer(context.organizerEmail, notice);
    await this.reassureBuyer(payload.buyerEmail, notice);
    if (ctx.messageId) await this.idempotency.markCompleted(ctx.messageId);
    this.logger.warn(
      {
        correlationId: ctx.correlationId,
        orderId: payload.orderId,
        amountSatang: payload.amountSatang,
        reason: payload.reason,
      },
      'Refund owed — organizer alerted',
    );
  }

  private async requireContext(
    payload: RefundRequiredEvent,
  ): Promise<RefundContext & { organizerEmail: string }> {
    const context = await this.repo.refundContext(
      payload.organizationId,
      payload.eventId,
    );
    if (!context?.organizerEmail) {
      throw new Error(
        `No contact address for event ${payload.eventId} — a refund of ${payload.amountSatang} satang on ${payload.reference} has nobody to action it.`,
      );
    }
    return { ...context, organizerEmail: context.organizerEmail };
  }

  private notice(
    payload: RefundRequiredEvent,
    context: RefundContext,
  ): RefundNotice {
    return {
      reference: payload.reference,
      eventName: context.eventName,
      amountSatang: payload.amountSatang,
      currency: payload.currency ?? DEFAULT_CURRENCY,
      reason: payload.reason,
      locale: context.locale,
    };
  }

  private async alertOrganizer(
    to: string,
    notice: RefundNotice,
  ): Promise<void> {
    await this.email.send({
      to,
      subject: organizerSubject(notice),
      text: organizerBody(notice),
    });
  }

  private async reassureBuyer(to: string, notice: RefundNotice): Promise<void> {
    await this.email.send({
      to,
      subject: buyerSubject(notice),
      text: buyerBody(notice),
    });
  }
}
