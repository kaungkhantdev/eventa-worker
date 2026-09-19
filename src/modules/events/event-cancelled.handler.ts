import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import { CANCELLATION_NOTICE_SLUG } from '../../db/schema/messaging';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { deliverToEach } from './broadcast-delivery';
import {
  EVENTS_CANCELLED,
  type EventCancelledEvent,
  eventCancelledSchema,
} from './event-cancelled.schema';
import { EventRecipientsRepository } from './event-recipients.repository';

const SUBJECT_PREFIX = 'Cancelled: ';

/**
 * Handles `events.cancelled` (US-EVT-08). Messages every confirmed attendee that
 * the event is off (recipients resolved at send time, delivered per-recipient).
 *
 * The organizer can switch it off (`message_templates.active`, US-MSG-01), and
 * an absent row means on. eventa-api warns before letting anyone disable this
 * one — attendees who paid for an event are entitled to hear it is cancelled —
 * but the decision is theirs, and this handler honours it. Checking it here is
 * what makes that switch real rather than decorative.
 *
 * The rest of US-EVT-08's fan-out — queue refunds, void issued tickets, clear the
 * waitlist — is intentionally NOT done here: refunds and ticket state are the
 * synchronous money/inventory path owned by eventa-api, and the waitlist domain
 * doesn't exist yet. This handler owns the attendee-notification side effect only.
 */
@Injectable()
export class EventCancelledHandler extends ValidatedHandler<EventCancelledEvent> {
  readonly routingKey = EVENTS_CANCELLED;
  protected readonly schema = eventCancelledSchema;
  private readonly logger = new Logger(EventCancelledHandler.name);

  constructor(
    private readonly recipients: EventRecipientsRepository,
    private readonly templates: MessageTemplatesRepository,
    private readonly email: EmailProvider,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  protected async process(
    payload: EventCancelledEvent,
    ctx: MessageContext,
  ): Promise<void> {
    if (await this.switchedOff(payload, ctx)) return;
    const recipients = await this.recipients.confirmedRecipients(
      payload.organizationId,
      payload.eventId,
    );
    const ledger = ctx.messageId
      ? this.idempotency.recipientLedger(ctx.messageId)
      : undefined;
    const { sent, failed } = await deliverToEach(
      this.email,
      recipients,
      (r) => ({
        to: r.email,
        subject: `${SUBJECT_PREFIX}${payload.name}`,
        text: this.body(r.name, payload.name, payload.reason),
      }),
      ledger,
    );
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        eventId: payload.eventId,
        sent,
        failed,
      },
      'Notified attendees of cancellation',
    );
    if (failed > 0) {
      throw new Error(
        `Cancellation notice partially failed: ${failed}/${recipients.length} undelivered`,
      );
    }
  }

  /**
   * Asked BEFORE the recipients are read. A message that will not be sent is no
   * reason to pull a list of people's names and addresses out of the database.
   */
  private async switchedOff(
    payload: EventCancelledEvent,
    ctx: MessageContext,
  ): Promise<boolean> {
    const active = await this.templates.isActive(
      payload.organizationId,
      CANCELLATION_NOTICE_SLUG,
    );
    if (active) return false;
    this.logger.log(
      { correlationId: ctx.correlationId, eventId: payload.eventId },
      'Cancellation notice is switched off for this workspace',
    );
    return true;
  }

  private body(
    attendeeName: string,
    eventName: string,
    reason: string,
  ): string {
    const lines = [
      `Hi ${attendeeName},`,
      '',
      `We're sorry to let you know that "${eventName}" has been cancelled.`,
    ];
    if (reason) lines.push('', `Reason: ${reason}`);
    lines.push(
      '',
      'If you purchased a ticket, our team will process your refund to the original payment method.',
    );
    return lines.join('\n');
  }
}
