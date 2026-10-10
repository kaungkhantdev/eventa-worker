import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderExpiryService } from './order-expiry.service';
import { safeError } from '../../common/logging/safe-error';

/** The registered job name, so it can be inspected or stopped via SchedulerRegistry. */
export const ORDER_EXPIRY_JOB = 'order-expiry';

/**
 * Runs the expiry sweep on a schedule (US-DISC-05).
 *
 * Every minute — far below any deadline a buyer sees, and cheap: one indexed
 * query that usually matches nothing. The cadence is a literal because that is
 * what `@Cron` takes; what actually governs correctness is
 * `ORDER_EXPIRY_GRACE_MS`, and that stays configurable on the service.
 *
 * A failed tick is logged and dropped, never rethrown: an unhandled rejection
 * inside a scheduled callback takes the worker process down, and a database
 * blip is not a reason to stop consuming the queue. The next tick retries the
 * identical rows, because the sweep selects by the data and holds no cursor —
 * which also makes overlapping ticks harmless.
 */
@Injectable()
export class OrderExpiryCron {
  private readonly logger = new Logger(OrderExpiryCron.name);

  constructor(private readonly expiry: OrderExpiryService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: ORDER_EXPIRY_JOB })
  async sweep(): Promise<void> {
    try {
      await this.expiry.sweep();
    } catch (err) {
      this.logger.error({ err: safeError(err) }, 'order expiry sweep failed');
    }
  }
}
