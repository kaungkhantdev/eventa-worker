import { Module } from '@nestjs/common';
import { Clock, SystemClock } from '../../common/time/clock';
import { ScheduledAnnouncementsCron } from './scheduled-announcements.cron';
import { ScheduledAnnouncementsRepository } from './scheduled-announcements.repository';
import { ScheduledAnnouncementsService } from './scheduled-announcements.service';

/**
 * Announcements an organizer scheduled for later (US-MSG-04/05).
 *
 * eventa-api records a scheduled announcement with no outbox event; this sends
 * it when its time comes by writing the same outbox row a send-now writes. So
 * there is no handler here: delivery is `AttendeesEmailHandler`'s, unchanged,
 * with its per-recipient ledger and delivery log.
 */
@Module({
  providers: [
    ScheduledAnnouncementsRepository,
    ScheduledAnnouncementsService,
    ScheduledAnnouncementsCron,
    { provide: Clock, useClass: SystemClock },
  ],
})
export class ScheduledAnnouncementsModule {}
