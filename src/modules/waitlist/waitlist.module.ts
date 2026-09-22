import { Module } from '@nestjs/common';
import { EmailModule } from '../../common/email/email.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { Clock, SystemClock } from '../../common/time/clock';
import { EventsModule } from '../events/events.module';
import { WaitlistOfferExpiredHandler } from './waitlist-offer-expired.handler';
import { WaitlistOfferedHandler } from './waitlist-offered.handler';
import { WaitlistRepository } from './waitlist.repository';

/**
 * The waitlist emails (US-REG-04): the offer of a seat, and the notice that
 * one lapsed. Consumes `waitlist.offered` — from eventa-api when an organizer
 * offers a seat, and from this worker's expiry sweep when it passes a lapsed
 * offer on — and `waitlist.offer_expired`, which only the sweep writes.
 *
 * Passing an offer on is not here: it has to happen inside the sweep's own
 * transaction, so it lives beside the sweep (`order-expiry/waitlist-queue.ts`).
 */
@Module({
  imports: [EmailModule, IdempotencyModule, EventsModule],
  providers: [
    WaitlistRepository,
    WaitlistOfferedHandler,
    WaitlistOfferExpiredHandler,
    { provide: Clock, useClass: SystemClock },
  ],
})
export class WaitlistModule {}
