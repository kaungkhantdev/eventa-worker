import { Module } from '@nestjs/common';
import { EmailModule } from '../../common/email/email.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { EventsModule } from '../events/events.module';
import { PaymentsRepository } from './payments.repository';
import { ReceiptSender } from './receipt-sender';
import { ReceiptsRepository } from './receipts.repository';
import { RefundRequiredHandler } from './refund-required.handler';

/**
 * Consumes `payment.refund_required` — money that arrived for a registration
 * that could not be honoured. Mirrors eventa-api's `payments`/`checkout`
 * contexts, which publish it. This service does not move money: it makes sure
 * the obligation reaches the organizer who must issue the refund (US-FIN-02)
 * and the buyer who is owed it.
 *
 * Also owns the payment receipt (US-SET-10). Nothing here consumes the event
 * that triggers it — `registration.confirmed` already has its handler, and the
 * consumer allows one per routing key — so `ReceiptSender` is exported for
 * that handler to call.
 */
@Module({
  imports: [EmailModule, IdempotencyModule, EventsModule],
  providers: [
    PaymentsRepository,
    RefundRequiredHandler,
    ReceiptsRepository,
    ReceiptSender,
  ],
  exports: [ReceiptSender],
})
export class PaymentsModule {}
