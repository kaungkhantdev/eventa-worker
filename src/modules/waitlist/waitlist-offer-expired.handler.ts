import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import {
  WAITLIST_OFFER_EXPIRED_KIND,
  WAITLIST_OFFER_SLUG,
} from '../../db/schema/messaging';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { EventRecipientsRepository } from '../events/event-recipients.repository';
import { readerLocale } from '../events/reader-locale';
import { expiredBody, expiredSubject } from './waitlist-notice';
import {
  type OfferExpiredEvent,
  WAITLIST_OFFER_EXPIRED,
  offerExpiredSchema,
} from './waitlist.schema';
import { WaitlistRepository } from './waitlist.repository';

/**
 * Handles `waitlist.offer_expired` (US-REG-04: "the attendee is told their
 * offer expired"). Written by the expiry sweep in the same transaction that
 * closed the offer and passed its seats on.
 *
 * Governed by the waitlist offer's own switch rather than one of its own:
 * somebody who was never told of an offer should not be told it expired.
 * Logged under its own kind, so the delivery log does not show it as an offer.
 */
@Injectable()
export class WaitlistOfferExpiredHandler extends ValidatedHandler<OfferExpiredEvent> {
  readonly routingKey = WAITLIST_OFFER_EXPIRED;
  protected readonly schema = offerExpiredSchema;
  private readonly logger = new Logger(WaitlistOfferExpiredHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly repo: WaitlistRepository,
    private readonly templates: MessageTemplatesRepository,
    private readonly recipients: EventRecipientsRepository,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  protected async process(
    payload: OfferExpiredEvent,
    ctx: MessageContext,
  ): Promise<void> {
    if (ctx.messageId && (await this.idempotency.isCompleted(ctx.messageId))) {
      return;
    }
    const sent = await this.notify(payload);
    if (ctx.messageId) await this.idempotency.markCompleted(ctx.messageId);
    this.logger.log(
      { correlationId: ctx.correlationId, orderId: payload.orderId, sent },
      'Waitlist offer expired',
    );
  }

  private async notify(payload: OfferExpiredEvent): Promise<boolean> {
    const on = await this.templates.isActive(
      payload.organizationId,
      WAITLIST_OFFER_SLUG,
    );
    if (!on) return false;
    const context = await this.repo.context(
      payload.organizationId,
      payload.orderId,
    );
    if (!context) return false;
    const locale = await readerLocale(this.recipients, {
      organizationId: payload.organizationId,
      eventId: payload.eventId,
      email: payload.buyerEmail,
    });
    const notice = {
      locale,
      name: payload.buyerName,
      eventName: context.eventName,
    };
    await this.email.send({
      to: payload.buyerEmail,
      subject: expiredSubject(notice),
      text: expiredBody(notice),
      delivery: {
        organizationId: payload.organizationId,
        kind: WAITLIST_OFFER_EXPIRED_KIND,
        recipientName: payload.buyerName,
        eventId: payload.eventId,
      },
    });
    return true;
  }
}
