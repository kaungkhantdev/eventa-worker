import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduledAnnouncementsService } from './scheduled-announcements.service';
import { safeError } from '../../common/logging/safe-error';

/** The registered job name, so it can be inspected or stopped via SchedulerRegistry. */
export const SCHEDULED_ANNOUNCEMENTS_JOB = 'scheduled-announcements';

/**
 * Runs the scheduled-announcement sweep (US-MSG-04/05).
 *
 * Every minute, because the organizer picked a minute: a send time is a
 * `datetime-local` on the Bangkok clock, and one going out up to a minute late
 * is the most anybody should notice. Cheap when idle — one query on a partial
 * index that usually matches nothing.
 *
 * A failed tick is logged and dropped, never rethrown: an unhandled rejection
 * inside a scheduled callback takes the worker process down. Nothing is lost —
 * the failed transaction rolled back, the rows are still `scheduled`, and the
 * next tick claims them again. Late rather than never: there is no staleness
 * cut-off, so a worker that was down sends what fell due while it was.
 */
@Injectable()
export class ScheduledAnnouncementsCron {
  private readonly logger = new Logger(ScheduledAnnouncementsCron.name);

  constructor(private readonly announcements: ScheduledAnnouncementsService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: SCHEDULED_ANNOUNCEMENTS_JOB })
  async sweep(): Promise<void> {
    try {
      await this.announcements.sendDue();
    } catch (err) {
      this.logger.error(
        { err: safeError(err) },
        'scheduled announcement sweep failed',
      );
    }
  }
}
