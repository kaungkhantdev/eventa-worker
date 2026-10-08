import { Injectable } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { fill, pickWording } from '../../common/messaging/merge-fields';
import { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import { PAYMENT_RECEIPT_SLUG } from '../../db/schema/messaging';
import { EventRecipientsRepository } from '../events/event-recipients.repository';
import { readerLocale } from '../events/reader-locale';
import {
  type PaymentReceipt,
  receiptBody,
  receiptSubject,
  serviceFeeOf,
} from './payment-receipt';
import { ReceiptsRepository, type ReceiptSource } from './receipts.repository';

/** The order a receipt is owed for, as the confirmation event names it. */
export interface PaidOrder {
  organizationId: number;
  orderId: string;
  eventId: string;
  buyerEmail: string;
}

export type ReceiptOutcome = 'sent' | 'switched-off' | 'nothing-paid';

/**
 * Emails the itemized receipt for a paid registration (US-SET-10).
 *
 * **Two switches, and both must be on.** The organizer's message setting for
 * the receipt (US-MSG-01/02) and the admin's "email receipts" payment
 * preference (US-SET-10) each say "do not email receipts"; honouring only one
 * would leave the other a switch that moves and changes nothing.
 *
 * **Only money that arrived gets a receipt.** The repository answers null for
 * a payment still pending or already refunded, and nothing is sent.
 *
 * Idempotency is the caller's: this sends when asked. The confirmation handler
 * asks once per order, and records that it did.
 */
@Injectable()
export class ReceiptSender {
  constructor(
    private readonly receipts: ReceiptsRepository,
    private readonly recipients: EventRecipientsRepository,
    private readonly templates: MessageTemplatesRepository,
    private readonly email: EmailProvider,
  ) {}

  async send(order: PaidOrder): Promise<ReceiptOutcome> {
    if (!(await this.switchedOn(order.organizationId))) return 'switched-off';
    const source = await this.receipts.loadReceipt(
      order.organizationId,
      order.orderId,
    );
    if (!source) return 'nothing-paid';

    const receipt = await this.compose(order, source);
    await this.email.send({
      to: order.buyerEmail,
      subject: receiptSubject(receipt),
      text: receiptBody(receipt),
      delivery: {
        organizationId: order.organizationId,
        kind: PAYMENT_RECEIPT_SLUG,
        recipientName: source.buyerName,
        eventId: order.eventId,
      },
    });
    return 'sent';
  }

  private async switchedOn(organizationId: number): Promise<boolean> {
    const [message, preference] = await Promise.all([
      this.templates.isActive(organizationId, PAYMENT_RECEIPT_SLUG),
      this.receipts.emailReceiptsOn(organizationId),
    ]);
    return message && preference;
  }

  private async compose(
    order: PaidOrder,
    source: ReceiptSource,
  ): Promise<PaymentReceipt> {
    const locale = await readerLocale(this.recipients, {
      organizationId: order.organizationId,
      eventId: order.eventId,
      email: order.buyerEmail,
    });
    const chosen = pickWording(
      await this.templates.wordingFor(
        order.organizationId,
        PAYMENT_RECEIPT_SLUG,
      ),
      locale,
    );
    const fields = {
      first_name: source.buyerName,
      event_name: source.eventName,
    };
    return {
      ...source,
      locale,
      serviceFeeSatang: serviceFeeOf(source),
      subject: chosen.subject && fill(chosen.subject, fields),
      opening: chosen.body && fill(chosen.body, fields),
    };
  }
}
