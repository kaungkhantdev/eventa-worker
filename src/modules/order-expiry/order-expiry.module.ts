import { Module } from '@nestjs/common';
import { Clock, SystemClock } from '../../common/time/clock';
import { OrderExpiryCron } from './order-expiry.cron';
import { OrderExpiryRepository } from './order-expiry.repository';
import { OrderExpiryService } from './order-expiry.service';

/**
 * Closing the orders nobody paid for (US-DISC-05).
 *
 * The one part of this worker that is not driven by a queue message. Every
 * other module here reacts to something eventa-api published; this one acts on
 * the passage of time, which no event can announce.
 *
 * It is also the one place the worker writes an order's lifecycle rather than
 * reading it — see the note on the `orders` schema mirror about what that costs.
 */
@Module({
  providers: [
    OrderExpiryRepository,
    OrderExpiryService,
    OrderExpiryCron,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [OrderExpiryService],
})
export class OrderExpiryModule {}
