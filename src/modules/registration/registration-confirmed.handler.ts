import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import {
  IdempotencyService,
  type SentLedger,
} from '../../common/idempotency/idempotency.service';
import { fill, pickWording } from '../../common/messaging/merge-fields';
import { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import {
  SmsDeliveryError,
  SmsProvider,
  type SmsMessage,
} from '../../common/sms/sms.provider';
import { toThaiMobileE164 } from '../../common/sms/thai-mobile';
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
import { confirmationSms } from './confirmation-sms';
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
 * The three messages one confirmed order can owe, each recorded once it is
 * done — two emails and, for an attendee who gave a mobile, a text.
 */
const CONFIRMATION_PART = 'confirmation';
const RECEIPT_PART = 'receipt';
const SMS_PART = 'sms';

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
 * - **An attendee who gave a Thai mobile also gets a TEXT** (US-DISC-06 AC5),
 *   and it goes LAST. A text is a courtesy that repeats what the email already
 *   carries, so no SMS provider outage may hold back somebody's ticket or
 *   their receipt. It is sent only where all four of these hold: the
 *   deployment has an SMS transport at all, the number normalises to a Thai
 *   mobile, the organizer's confirmation is on AND lists the sms channel, and
 *   there are still live tickets. A refusal the transport calls FINAL is logged
 *   and swallowed for that same reason — see `sendText`.
 *
 * Each of the three messages is recorded as done once it is away, and the
 * message as a whole only after all of them. A crash between them is
 * re-processed on redelivery, and sends only what is still owed: the attendee
 * gets the receipt they missed, not a second copy of their tickets.
 */
@Injectable()
export class RegistrationConfirmedHandler extends ValidatedHandler<RegistrationConfirmedEvent> {
  readonly routingKey = REGISTRATION_CONFIRMED;
  protected readonly schema = registrationConfirmedSchema;
  private readonly logger = new Logger(RegistrationConfirmedHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly sms: SmsProvider,
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
    await once(done, SMS_PART, () => this.text(payload, ctx));
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

  /**
   * The confirmation text (US-DISC-06 AC5), for an attendee who gave a Thai
   * mobile and whose organizer has the sms channel on.
   *
   * No branch out of here dead-letters the message. Not having a mobile number
   * is the NORMAL case, and a refusal the transport itself calls final is not
   * worth parking a registration over either — see {@link sendText}.
   */
  private async text(
    payload: RegistrationConfirmedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const to = await this.textRecipient(payload, ctx);
    if (!to) return;

    // Read again rather than reused from `confirm`: on a redelivery that part
    // is already recorded as done and never runs, so this one has to stand on
    // its own. The same read also re-checks that the tickets still exist.
    const source = await this.repo.loadConfirmation(
      payload.organizationId,
      payload.orderId,
      payload.eventId,
      payload.buyerEmail,
    );
    if (!source || source.tickets.length === 0) return;

    const locale = pickLocale(source);
    const away = await this.sendText(
      textMessage(to, locale, payload, source),
      payload.orderId,
      ctx,
    );
    if (!away) return;
    this.logger.log(
      { correlationId: ctx.correlationId, orderId: payload.orderId, locale },
      'Sent registration confirmation by SMS',
    );
  }

  /**
   * Send the text, and decide what a failure to send it MEANS.
   *
   * A refusal the transport calls final — a rejected credential, a region the
   * account may not text, a number the provider will not route — is swallowed,
   * and the part is recorded as done. Retrying it would fail identically, and
   * the cost of not swallowing it is severe: by the time the text goes the
   * attendee already has their tickets and their VAT receipt, so nacking would
   * park a message whose expensive halves are delivered, and a DLQ replay more
   * than `IDEMPOTENCY_TTL_SECONDS` later finds an expired ledger and sends a
   * second copy of both. Account-level refusals (a rotated Twilio token
   * answering 401 to everything) would do that to every confirmation at once.
   *
   * Nothing is hidden by swallowing it: `RecordingSmsProvider` has already
   * written the `failed` delivery row the organizer reads in US-MSG-06.
   *
   * A retryable failure — a provider outage, a timeout — is rethrown and rides
   * the retry ladder, as does anything that is not an `SmsDeliveryError` at
   * all, since only the transport can tell the two apart.
   *
   * @returns whether the text actually went out.
   */
  private async sendText(
    message: SmsMessage,
    orderId: string,
    ctx: MessageContext,
  ): Promise<boolean> {
    try {
      await this.sms.send(message);
      return true;
    } catch (cause) {
      if (!isFinalRefusal(cause)) throw cause;
      // `SmsDeliveryError` guarantees its message quotes neither the number
      // nor the body — only the status and the provider's own code.
      this.logger.warn(
        { correlationId: ctx.correlationId, orderId, reason: cause.message },
        'The SMS provider refused the confirmation text for good — not retried',
      );
      return false;
    }
  }

  /**
   * The number to text, or null with a reason logged — NEVER the number
   * itself, which is PII the consumer would then publish to the log.
   *
   * Ordered cheapest first: a deployment with no SMS transport asks the
   * database nothing.
   */
  private async textRecipient(
    payload: RegistrationConfirmedEvent,
    ctx: MessageContext,
  ): Promise<string | null> {
    const note = (message: string): null => {
      this.logger.log(
        { correlationId: ctx.correlationId, orderId: payload.orderId },
        message,
      );
      return null;
    };
    if (!this.sms.enabled) return note('SMS is not configured — no text sent');

    const to = toThaiMobileE164(payload.buyerPhone ?? '');
    if (!to) return note('No Thai mobile on this order — no text sent');

    const allowed = await this.templates.sendsOn(
      payload.organizationId,
      REGISTRATION_CONFIRMATION_SLUG,
      'sms',
    );
    return allowed
      ? to
      : note('The confirmation’s SMS channel is off for this workspace');
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

/**
 * The text itself, and the person the delivery log files it under.
 *
 * `delivery` carries no phone column on purpose: `message_deliveries` has none,
 * and a text is filed under the same person as their email.
 */
function textMessage(
  to: string,
  locale: Locale,
  payload: RegistrationConfirmedEvent,
  source: ConfirmationSource,
): SmsMessage {
  return {
    to,
    text: confirmationSms({
      locale,
      eventName: source.event.name,
      reference: payload.reference,
      ticketsUrl: payload.ticketsUrl,
    }),
    delivery: {
      organizationId: payload.organizationId,
      kind: REGISTRATION_CONFIRMATION_SLUG,
      recipientName: payload.buyerName,
      recipientEmail: payload.buyerEmail,
      eventId: payload.eventId,
    },
  };
}

/**
 * A send that will fail the same way however often it is attempted. Only the
 * transport can say so, which is why `SmsDeliveryError` carries the verdict on
 * a field of its own rather than leaving it to be guessed from a status code.
 */
function isFinalRefusal(cause: unknown): cause is SmsDeliveryError {
  return cause instanceof SmsDeliveryError && !cause.retryable;
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
