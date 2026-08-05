import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { REGISTRATION_CONFIRMATION_SLUG } from '../../db/schema/messaging';
import type { Locale } from '../../db/schema/events';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import {
  type ConfirmationDetails,
  confirmationBody,
  confirmationSubject,
} from './confirmation-email';
import {
  REGISTRATION_CONFIRMED,
  type RegistrationConfirmedEvent,
  registrationConfirmedSchema,
} from './registration-confirmed.schema';
import type {
  ConfirmationEvent,
  ConfirmationSource,
} from './registration.repository';
import { RegistrationRepository } from './registration.repository';

const DEFAULT_CURRENCY = 'THB';

/**
 * Handles `registration.confirmed` (US-MSG-01): the email that carries the
 * attendee's tickets and order summary once their registration is paid for.
 *
 * Three things shape this handler:
 *
 * - **The tickets are read live.** The message deliberately carries no QR
 *   tokens — they are bearer credentials for admission, so they never sit on
 *   the bus or in a retry queue. If every ticket has since been voided, nothing
 *   is sent: an email promising a ticket that no longer admits anyone is worse
 *   than no email.
 * - **The organizer can switch it off** (`message_templates.active`), and an
 *   absent row means on, so a workspace that never opened its settings still
 *   sends confirmations. Note this is a workspace-level switch, not per-event —
 *   neither the story nor the data model gives per-event control.
 * - **Language follows the person**: their own preference, then the event's,
 *   then the workspace's, then English. Ticket delivery is transactional, so it
 *   is not subject to any marketing opt-out.
 *
 * Completion is recorded only AFTER the send, so a crash mid-flight is
 * re-processed on redelivery rather than silently skipped.
 */
@Injectable()
export class RegistrationConfirmedHandler extends ValidatedHandler<RegistrationConfirmedEvent> {
  readonly routingKey = REGISTRATION_CONFIRMED;
  protected readonly schema = registrationConfirmedSchema;
  private readonly logger = new Logger(RegistrationConfirmedHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly repo: RegistrationRepository,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  protected async process(
    payload: RegistrationConfirmedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    if (await this.alreadySent(ctx)) return;
    if (
      !(await this.repo.isMessageActive(
        payload.organizationId,
        REGISTRATION_CONFIRMATION_SLUG,
      ))
    ) {
      this.logger.log(
        { correlationId: ctx.correlationId, orderId: payload.orderId },
        'Registration confirmation is switched off for this workspace',
      );
      return;
    }
    const source = await this.repo.loadConfirmation(
      payload.organizationId,
      payload.orderId,
      payload.eventId,
      payload.buyerEmail,
    );
    if (!source || source.tickets.length === 0) {
      this.logger.warn(
        { correlationId: ctx.correlationId, orderId: payload.orderId },
        'No live tickets for this order — nothing to confirm',
      );
      return;
    }
    await this.deliver(payload, source, ctx);
  }

  private async alreadySent(ctx: MessageContext): Promise<boolean> {
    return ctx.messageId
      ? this.idempotency.isCompleted(ctx.messageId)
      : Promise.resolve(false);
  }

  private async deliver(
    payload: RegistrationConfirmedEvent,
    source: ConfirmationSource,
    ctx: MessageContext,
  ): Promise<void> {
    const details = this.details(payload, source);
    await this.email.send({
      to: payload.buyerEmail,
      subject: confirmationSubject(details),
      text: confirmationBody(details),
    });
    if (ctx.messageId) await this.idempotency.markCompleted(ctx.messageId);
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        orderId: payload.orderId,
        tickets: source.tickets.length,
        locale: details.locale,
      },
      'Sent registration confirmation',
    );
  }

  private details(
    payload: RegistrationConfirmedEvent,
    source: ConfirmationSource,
  ): ConfirmationDetails {
    return {
      locale: pickLocale(source),
      buyerName: payload.buyerName,
      reference: payload.reference,
      eventName: source.event.name,
      whenText: formatWhen(source.event),
      whereText: formatWhere(source.event),
      isOnline: source.event.isOnline,
      totalSatang: payload.totalSatang,
      currency: payload.currency ?? DEFAULT_CURRENCY,
      paid: payload.paid ?? payload.totalSatang > 0,
      tickets: source.tickets,
      ticketsUrl: `/my/orders/${payload.orderId}`,
    };
  }
}

/** The person's own choice first, then the event's, then the workspace's. */
function pickLocale(source: ConfirmationSource): Locale {
  return source.userLocale ?? source.event.locale ?? source.orgLocale;
}

/** In the EVENT's timezone — an attendee reads the local door time, not UTC. */
function formatWhen(event: ConfirmationEvent): string {
  return event.startAt.toLocaleString('en-GB', {
    timeZone: event.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  });
}

/**
 * Null when there is genuinely nothing to say — the body omits the line rather
 * than printing an empty one.
 */
function formatWhere(event: ConfirmationEvent): string | null {
  if (event.isOnline) return event.onlineNote;
  return [event.venueName, event.city].filter(Boolean).join(', ') || null;
}
