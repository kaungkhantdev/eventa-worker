import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduledMessagesService } from './scheduled-messages.service';
import { safeError } from '../../common/logging/safe-error';

/** The registered job name, so it can be inspected or stopped via SchedulerRegistry. */
export const SCHEDULED_MESSAGES_JOB = 'scheduled-messages';

/**
 * Sends the reminders and thank-yous on a schedule (US-MSG-01/08).
 *
 * Hourly. Both are meant to land "about a day" from an event, so an hour of
 * slack is invisible, and jobs that usually find nothing need not ask more
 * often than that.
 *
 * Each sweep fails on its own: a broken reminder run must not stop the
 * thank-yous, and vice versa. A failed sweep is logged and dropped, never
 * rethrown — the same rule as the order-expiry cron — because an unhandled
 * rejection inside a scheduled callback takes the worker down. The next tick
 * resumes from the data.
 */
@Injectable()
export class ScheduledMessagesCron {
  private readonly logger = new Logger(ScheduledMessagesCron.name);

  constructor(private readonly messages: ScheduledMessagesService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: SCHEDULED_MESSAGES_JOB })
  async run(): Promise<void> {
    await this.safely('event reminder', () => this.messages.sendReminders());
    await this.safely('post-event thank-you', () =>
      this.messages.sendThankYous(),
    );
  }

  private async safely(
    what: string,
    sweep: () => Promise<number>,
  ): Promise<void> {
    try {
      await sweep();
    } catch (err) {
      this.logger.error({ err: safeError(err) }, `${what} sweep failed`);
    }
  }
}
