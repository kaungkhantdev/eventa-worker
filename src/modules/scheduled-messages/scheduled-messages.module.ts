import { Module } from '@nestjs/common';
import { Clock, SystemClock } from '../../common/time/clock';
import { EventsModule } from '../events/events.module';
import { ScheduledMessagesCron } from './scheduled-messages.cron';
import { ScheduledMessagesRepository } from './scheduled-messages.repository';
import { ScheduledMessagesService } from './scheduled-messages.service';
import { ScheduledSender } from './scheduled-sender';

/**
 * Messages sent on a schedule rather than in reply to an event: the reminder a
 * day before, the thank-you a day after (US-MSG-01/08). Reads EventsModule for
 * the attendee list and their languages — the same ones a cancellation uses.
 */
@Module({
  imports: [EventsModule],
  providers: [
    ScheduledMessagesRepository,
    ScheduledSender,
    ScheduledMessagesService,
    ScheduledMessagesCron,
    { provide: Clock, useClass: SystemClock },
  ],
})
export class ScheduledMessagesModule {}
