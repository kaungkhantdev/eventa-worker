import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { fill, pickWording } from '../../common/messaging/merge-fields';
import { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import { Clock } from '../../common/time/clock';
import { WAITLIST_OFFER_SLUG } from '../../db/schema/messaging';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { EventRecipientsRepository } from '../events/event-recipients.repository';
import { readerLocale } from '../events/reader-locale';
import {
  offerBody,
  offerStillOpen,
  offerSubject,
  type OfferNotice,
} from './waitlist-notice';
import {
  WAITLIST_OFFERED,
  type WaitlistOfferedEvent,
  waitlistOfferedSchema,
} from './waitlist.schema';
import {
  WaitlistRepository,
  type WaitlistContext,
} from './waitlist.repository';

/**
 * Handles `waitlist.offered` (US-REG-04): tells someone on the waitlist that
 * seats are held for them, what they cost, and the deadline to pay.
 *
 * The same message comes from two places — an organizer's offer, written by
 * eventa-api, and a lapsed offer the expiry sweep passed on — and this handler
 * treats them alike.
 *
 * The order is re-read before sending. The outbox and the queue can run
 * behind, and an offer that has since been paid for, or has lapsed, must not
 * arrive saying "pay now". Nothing sent in that case is still a success: the
 * message is marked done.
 */
@Injectable()
export class WaitlistOfferedHandler extends ValidatedHandler<WaitlistOfferedEvent> {
  readonly routingKey = WAITLIST_OFFERED;
  protected readonly schema = waitlistOfferedSchema;
  private readonly logger = new Logger(WaitlistOfferedHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly repo: WaitlistRepository,
    private readonly templates: MessageTemplatesRepository,
    private readonly recipients: EventRecipientsRepository,
    private readonly idempotency: IdempotencyService,
    private readonly clock: Clock,
  ) {
    super();
  }

  protected async process(
    payload: WaitlistOfferedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    if (ctx.messageId && (await this.idempotency.isCompleted(ctx.messageId))) {
      return;
    }
    const context = await this.sendable(payload);
    if (context) await this.send(payload, context);
    if (ctx.messageId) await this.idempotency.markCompleted(ctx.messageId);
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        orderId: payload.orderId,
        sent: context !== null,
      },
      'Waitlist offer',
    );
  }

  /** The order as it stands now, if an offer email should still go at all. */
  private async sendable(
    payload: WaitlistOfferedEvent,
  ): Promise<WaitlistContext | null> {
    const on = await this.templates.isActive(
      payload.organizationId,
      WAITLIST_OFFER_SLUG,
    );
    if (!on) return null;
    const context = await this.repo.context(
      payload.organizationId,
      payload.orderId,
    );
    return context && offerStillOpen(context, this.clock.now())
      ? context
      : null;
  }

  private async send(
    payload: WaitlistOfferedEvent,
    context: WaitlistContext,
  ): Promise<void> {
    const notice = await this.compose(payload, context);
    await this.email.send({
      to: payload.buyerEmail,
      subject: offerSubject(notice),
      text: offerBody(notice),
      delivery: {
        organizationId: payload.organizationId,
        kind: WAITLIST_OFFER_SLUG,
        recipientName: payload.buyerName,
        eventId: payload.eventId,
      },
    });
  }

  private async compose(
    payload: WaitlistOfferedEvent,
    context: WaitlistContext,
  ): Promise<OfferNotice> {
    const locale = await readerLocale(this.recipients, {
      organizationId: payload.organizationId,
      eventId: payload.eventId,
      email: payload.buyerEmail,
    });
    const chosen = pickWording(
      await this.templates.wordingFor(
        payload.organizationId,
        WAITLIST_OFFER_SLUG,
      ),
      locale,
    );
    const fields = {
      first_name: payload.buyerName,
      event_name: context.eventName,
      ticket_type: payload.ticketTypeName,
    };
    return {
      locale,
      name: payload.buyerName,
      eventName: context.eventName,
      ticketTypeName: payload.ticketTypeName,
      ticketCount: payload.ticketCount,
      totalSatang: payload.totalSatang,
      currency: payload.currency,
      offerExpiresAt: new Date(payload.offerExpiresAt),
      timezone: context.timezone,
      payUrl: payload.payUrl,
      subject: chosen.subject && fill(chosen.subject, fields),
      opening: chosen.body && fill(chosen.body, fields),
    };
  }
}
