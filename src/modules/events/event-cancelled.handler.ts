import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { fill, pickWording } from '../../common/messaging/merge-fields';
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
 * A cancellation goes to every confirmed attendee at once, and the payload
 * carries no per-person language. English until the event's own locale reaches
 * this event — which is a change to what eventa-api publishes, not to this.
 */
const DEFAULT_LOCALE = 'en' as const;

function fieldsFor(
  attendeeName: string,
  payload: { name: string; reason: string },
): Record<string, string> {
  return {
    first_name: attendeeName,
    event_name: payload.name,
    reason: payload.reason,
  };
}

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
    // The organizer's own wording, where they wrote any (US-MSG-02). Read once
    // for the batch rather than per recipient.
    const wording = pickWording(
      await this.templates.wordingFor(
        payload.organizationId,
        CANCELLATION_NOTICE_SLUG,
      ),
      DEFAULT_LOCALE,
    );
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
        subject: wording.subject
          ? fill(wording.subject, fieldsFor(r.name, payload))
          : `${SUBJECT_PREFIX}${payload.name}`,
        text: this.body(r.name, payload.name, payload.reason, wording.body),
        delivery: {
          organizationId: payload.organizationId,
          kind: CANCELLATION_NOTICE_SLUG,
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

  /**
   * An organizer's wording replaces the explanation, never the refund line.
   *
   * Somebody whose event was cancelled needs to know their money is coming
   * back, and that is not a sentence to leave to whoever was editing a
   * template at the time.
   */
  private body(
    attendeeName: string,
    eventName: string,
    reason: string,
    override?: string | null,
  ): string {
    const lines = override
      ? [
          fill(override, {
            first_name: attendeeName,
            event_name: eventName,
            reason,
          }),
        ]
      : [
          `Hi ${attendeeName},`,
          '',
          `We're sorry to let you know that "${eventName}" has been cancelled.`,
          ...(reason ? ['', `Reason: ${reason}`] : []),
        ];
    lines.push(
      '',
      'If you purchased a ticket, our team will process your refund to the original payment method.',
    );
    return lines.join('\n');
  }
}
