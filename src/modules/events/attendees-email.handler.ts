import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { inlineText } from '../../common/messaging/inline-text';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import {
  EVENTS_ATTENDEES_EMAIL_REQUESTED,
  type AttendeesEmailRequestedEvent,
  attendeesEmailRequestedSchema,
} from './attendees-email.schema';
import { ANNOUNCEMENT_KIND } from '../../db/schema/messaging';
import { deliverToEach } from './broadcast-delivery';
import { EventRecipientsRepository } from './event-recipients.repository';

/**
 * Handles `events.attendees_email_requested` (US-EVT-14 "Email all attendees").
 * The payload carries no addresses, so this resolves the confirmed attendees at
 * send time (no PII on the bus, no stale list) and delivers the organizer's message
 * to each recipient individually — one send per person, never a shared To/CC — so
 * no attendee ever sees another's address.
 */
@Injectable()
export class AttendeesEmailHandler extends ValidatedHandler<AttendeesEmailRequestedEvent> {
  readonly routingKey = EVENTS_ATTENDEES_EMAIL_REQUESTED;
  protected readonly schema = attendeesEmailRequestedSchema;
  private readonly logger = new Logger(AttendeesEmailHandler.name);

  constructor(
    private readonly recipients: EventRecipientsRepository,
    private readonly email: EmailProvider,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  protected async process(
    payload: AttendeesEmailRequestedEvent,
    ctx: MessageContext,
  ): Promise<void> {
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
        // The organizer typed this and it arrives raw off the bus. Both the
        // send-now broadcast and the scheduled announcement converge here, so
        // this is the one place either can be made safe.
        subject: inlineText(payload.subject),
        text: payload.message,
        delivery: {
          organizationId: payload.organizationId,
          kind: ANNOUNCEMENT_KIND,
          recipientName: r.name,
          eventId: payload.eventId,
        },
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
      'Delivered attendee broadcast',
    );
    if (failed > 0) {
      // Surface the partial failure so the message is dead-lettered for retry
      // rather than silently acked (no recipient addresses in the message).
      throw new Error(
        `Attendee broadcast partially failed: ${failed}/${recipients.length} undelivered`,
      );
    }
  }
}
