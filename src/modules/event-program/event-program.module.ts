import { Module } from '@nestjs/common';
import { EmailModule } from '../../common/email/email.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { EventsModule } from '../events/events.module';
import { EventProgramRepository } from './event-program.repository';
import { SessionChangedHandler } from './session-changed.handler';

/**
 * The programme notices (mirrors eventa-api's `event-program` context).
 *
 * Consumes `program.session_changed` — US-PROG-03's optional notice that a
 * session an attendee has on their schedule has moved to a new day, time or
 * room. Nothing is consumed for a session that is REMOVED: US-PROG-04 is
 * explicit that removal notifies nobody, and eventa-api publishes no event for
 * it.
 *
 * `EventsModule` is imported for `EventRecipientsRepository` — the same
 * recipient set, in the same languages, as every other message about an event,
 * so nobody gets their ticket in Thai and this in English.
 */
@Module({
  imports: [EmailModule, IdempotencyModule, EventsModule],
  providers: [EventProgramRepository, SessionChangedHandler],
})
export class EventProgramModule {}
