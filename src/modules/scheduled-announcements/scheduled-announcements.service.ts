import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../../common/time/clock';
import type { Env } from '../../config/env.validation';
import { ScheduledAnnouncementsRepository } from './scheduled-announcements.repository';

/**
 * Sends the announcements organizers scheduled, when they fall due
 * (US-MSG-04/05).
 *
 * One job: ask the repository to send one batch of what is due now, and say
 * what it did. It decides nothing about *when* — that is the cron next door —
 * so this stays a plain function a test, a schedule, or an operator draining a
 * backlog by hand can all call.
 *
 * Logs ids and counts, never a subject, a body or an address: an announcement
 * is the organizer's words to their attendees, not operational data.
 */
@Injectable()
export class ScheduledAnnouncementsService {
  private readonly logger = new Logger(ScheduledAnnouncementsService.name);
  private readonly batch: number;

  constructor(
    private readonly repo: ScheduledAnnouncementsRepository,
    config: ConfigService<Env, true>,
    private readonly clock: Clock,
  ) {
    this.batch = config.get('SCHEDULED_ANNOUNCEMENTS_BATCH', { infer: true });
  }

  /** Send one batch of due announcements. Returns how many went. */
  async sendDue(): Promise<number> {
    const { sent, dropped } = await this.repo.sendDue({
      now: this.clock.now(),
      limit: this.batch,
    });
    if (dropped.length > 0) {
      this.logger.warn(
        { ids: dropped.map((a) => a.id) },
        'dropped scheduled announcements whose event was deleted',
      );
    }
    if (sent.length > 0) {
      this.logger.log(
        {
          count: sent.length,
          announcements: sent.map((a) => ({
            id: a.id,
            recipientCount: a.recipientCount,
          })),
        },
        'sent scheduled announcements',
      );
    }
    return sent.length;
  }
}
