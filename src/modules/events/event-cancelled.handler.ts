import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { fill, pickWording } from '../../common/messaging/merge-fields';
import {
  MessageTemplatesRepository,
  type TemplateWording,
} from '../../common/messaging/message-templates.repository';
import type { Locale } from '../../db/schema/events';
import { CANCELLATION_NOTICE_SLUG } from '../../db/schema/messaging';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { deliverToEach } from './broadcast-delivery';
import { cancellationBody, cancellationSubject } from './cancellation-notice';
import {
  EVENTS_CANCELLED,
  type EventCancelledEvent,
  eventCancelledSchema,
} from './event-cancelled.schema';
import {
  EventRecipientsRepository,
  type Recipient,
} from './event-recipients.repository';

/**
 * Handles `events.cancelled` (US-EVT-08). Messages every confirmed attendee that
 * the event is off (recipients resolved at send time, delivered per-recipient).
 *
 * Three things shape it:
 *
 * - **The organizer can switch it off** (`message_templates.active`, US-MSG-01),
 *   and an absent row means on. eventa-api warns before letting anyone disable
 *   this one — attendees who paid for an event are entitled to hear it is off —
 *   but the decision is theirs, and checking it here is what makes that switch
 *   real rather than decorative.
 * - **Language follows the PERSON**: their own preference, then the event's,
 *   then the workspace's — the same order the registration confirmation uses,
 *   so nobody gets their ticket in Thai and their cancellation in English. It
 *   is resolved from the database rather than the payload, because a
 *   cancellation goes to everybody at once and only the database knows each of
 *   them.
 * - **The organizer's wording is chosen per reader** (US-MSG-02), so their Thai
 *   reaches their Thai attendees. It replaces the explanation, never the refund
 *   line.
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
    // Everything a message needs, read ONCE for the batch — never a query per
    // recipient, which on a 2,000-person event is 2,000 round trips.
    const [own, fallback, wording] = await Promise.all([
      this.recipients.attendeeLocales(recipients.map((r) => r.email)),
      this.recipients.fallbackLocale(payload.organizationId, payload.eventId),
      this.templates.wordingFor(
        payload.organizationId,
        CANCELLATION_NOTICE_SLUG,
      ),
    ]);

    const ledger = ctx.messageId
      ? this.idempotency.recipientLedger(ctx.messageId)
      : undefined;
    const { sent, failed } = await deliverToEach(
      this.email,
      recipients,
      (r) => ({
        ...this.message(r, own.get(r.email) ?? fallback, payload, wording),
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

  /** One reader's notice, in their language and with the organizer's words. */
  private message(
    recipient: Recipient,
    locale: Locale,
    payload: EventCancelledEvent,
    wording: TemplateWording,
  ): { to: string; subject: string; text: string } {
    const chosen = pickWording(wording, locale);
    const fields = {
      first_name: recipient.name,
      event_name: payload.name,
      reason: payload.reason,
    };
    const notice = {
      attendeeName: recipient.name,
      eventName: payload.name,
      reason: payload.reason,
      locale,
      subject: chosen.subject && fill(chosen.subject, fields),
      opening: chosen.body && fill(chosen.body, fields),
    };
    return {
      to: recipient.email,
      subject: cancellationSubject(notice),
      text: cancellationBody(notice),
    };
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
}
