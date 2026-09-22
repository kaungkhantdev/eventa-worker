import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import {
  IdempotencyService,
  type SentLedger,
} from '../../common/idempotency/idempotency.service';
import { fill, pickWording } from '../../common/messaging/merge-fields';
import { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import { REGISTRATION_CONFIRMATION_SLUG } from '../../db/schema/messaging';
import type { Locale } from '../../db/schema/events';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { ReceiptSender } from '../payments/receipt-sender';
import {
  type ConfirmationDetails,
  confirmationBody,
  confirmationSubject,
  formatWhen,
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

/** The two emails one confirmed order can owe, each recorded once it is done. */
const CONFIRMATION_PART = 'confirmation';
const RECEIPT_PART = 'receipt';

/**
 * Handles `registration.confirmed` (US-MSG-01): the email that carries the
 * attendee's tickets and order summary once their registration is paid for.
 *
 * Three things shape this handler:
 *
 * - **The tickets are read live, and their tokens never leave the database.**
 *   A QR token is a bearer credential that admits someone to a paid event, so
 *   it is carried neither on the bus nor in the email body — mail is logged,
 *   forwarded and scanned. The email names each ticket and links to the page
 *   that renders the scannable code. If every ticket has since been voided,
 *   nothing is sent: an email promising a ticket that no longer admits anyone
 *   is worse than no email.
 * - **The organizer can switch it off** (`message_templates.active`), and an
 *   absent row means on, so a workspace that never opened its settings still
 *   sends confirmations. Note this is a workspace-level switch, not per-event —
 *   neither the story nor the data model gives per-event control.
 * - **Language follows the person**: their own preference, then the event's,
 *   then the workspace's, then English. Ticket delivery is transactional, so it
 *   is not subject to any marketing opt-out.
 *
 * - **A paid order also gets its receipt** (US-SET-10), sent after the
 *   confirmation by `ReceiptSender`, which has its own two switches. The
 *   consumer allows one handler per routing key, so the receipt is sent from
 *   here rather than from a second handler that would silently replace this one.
 *
 * Each of the two emails is recorded as done once it is away, and the message
 * as a whole only after both. A crash between them is re-processed on
 * redelivery, and sends only what is still owed: the attendee gets the receipt
 * they missed, not a second copy of their tickets.
 */
@Injectable()
export class RegistrationConfirmedHandler extends ValidatedHandler<RegistrationConfirmedEvent> {
  readonly routingKey = REGISTRATION_CONFIRMED;
  protected readonly schema = registrationConfirmedSchema;
  private readonly logger = new Logger(RegistrationConfirmedHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly repo: RegistrationRepository,
    private readonly templates: MessageTemplatesRepository,
    private readonly idempotency: IdempotencyService,
    private readonly receipts: ReceiptSender,
  ) {
    super();
  }

  protected async process(
    payload: RegistrationConfirmedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    if (await this.alreadySent(ctx)) return;
    const done = ctx.messageId
      ? this.idempotency.recipientLedger(ctx.messageId)
      : null;
    await once(done, CONFIRMATION_PART, () => this.confirm(payload, ctx));
    if (isPaid(payload)) {
      await once(done, RECEIPT_PART, () => this.sendReceipt(payload, ctx));
    }
    if (ctx.messageId) await this.idempotency.markCompleted(ctx.messageId);
  }

  private async confirm(
    payload: RegistrationConfirmedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    if (
      !(await this.templates.isActive(
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
    const chosen = pickWording(
      await this.templates.wordingFor(
        payload.organizationId,
        REGISTRATION_CONFIRMATION_SLUG,
      ),
      details.locale,
    );
    const fields = {
      first_name: details.buyerName,
      event_name: details.eventName,
    };

    await this.email.send({
      to: payload.buyerEmail,
      subject: confirmationSubject(
        details,
        chosen.subject && fill(chosen.subject, fields),
      ),
      text: confirmationBody(details, chosen.body && fill(chosen.body, fields)),
      delivery: {
        organizationId: payload.organizationId,
        kind: REGISTRATION_CONFIRMATION_SLUG,
        recipientName: payload.buyerName,
        eventId: payload.eventId,
      },
    });
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

  private async sendReceipt(
    payload: RegistrationConfirmedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const outcome = await this.receipts.send({
      organizationId: payload.organizationId,
      orderId: payload.orderId,
      eventId: payload.eventId,
      buyerEmail: payload.buyerEmail,
    });
    this.logger.log(
      { correlationId: ctx.correlationId, orderId: payload.orderId, outcome },
      'Payment receipt',
    );
  }

  private details(
    payload: RegistrationConfirmedEvent,
    source: ConfirmationSource,
  ): ConfirmationDetails {
    const locale = pickLocale(source);
    return {
      locale,
      buyerName: payload.buyerName,
      reference: payload.reference,
      eventName: source.event.name,
      whenText: formatWhen(source.event.startAt, source.event.timezone, locale),
      whereText: formatWhere(source.event),
      isOnline: source.event.isOnline,
      totalSatang: payload.totalSatang,
      currency: payload.currency ?? DEFAULT_CURRENCY,
      paid: isPaid(payload),
      tickets: source.tickets,
      ticketsUrl: payload.ticketsUrl,
    };
  }
}

/**
 * Money changed hands. Older producers omitted `paid`, and for them a total
 * above nothing is the same fact.
 */
function isPaid(payload: RegistrationConfirmedEvent): boolean {
  return payload.paid ?? payload.totalSatang > 0;
}

/** Run `work` unless this message already did it; record it once it has. */
async function once(
  done: SentLedger | null,
  part: string,
  work: () => Promise<void>,
): Promise<void> {
  if (done && (await done.wasSent(part))) return;
  await work();
  await done?.markSent(part);
}

/** The person's own choice first, then the event's, then the workspace's. */
function pickLocale(source: ConfirmationSource): Locale {
  return source.userLocale ?? source.event.locale ?? source.orgLocale;
}

/**
 * Null when there is genuinely nothing to say — the body omits the line rather
 * than printing an empty one.
 */
function formatWhere(event: ConfirmationEvent): string | null {
  if (event.isOnline) return event.onlineNote;
  return [event.venueName, event.city].filter(Boolean).join(', ') || null;
}
