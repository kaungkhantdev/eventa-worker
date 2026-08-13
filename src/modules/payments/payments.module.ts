import { Module } from '@nestjs/common';
import { EmailModule } from '../../common/email/email.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { PaymentsRepository } from './payments.repository';
import { RefundRequiredHandler } from './refund-required.handler';

/**
 * Consumes `payment.refund_required` — money that arrived for a registration
 * that could not be honoured. Mirrors eventa-api's `payments`/`checkout`
 * contexts, which publish it. This service does not move money: it makes sure
 * the obligation reaches the organizer who must issue the refund (US-FIN-02)
 * and the buyer who is owed it.
 */
@Module({
  imports: [EmailModule, IdempotencyModule],
  providers: [PaymentsRepository, RefundRequiredHandler],
})
export class PaymentsModule {}
