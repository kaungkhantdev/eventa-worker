import { Module } from '@nestjs/common';
import { AttendeesEmailHandler } from './attendees-email.handler';
import { EventCancelledHandler } from './event-cancelled.handler';
import { EventPublishedHandler } from './event-published.handler';
import { EventRecipientsRepository } from './event-recipients.repository';

/**
 * Events domain (mirrors eventa-api's events bounded context). Consumes the
 * `events.*` outbox events the API emits — publish notice (US-EVT-07), cancellation
 * notices (US-EVT-08) and the "email all attendees" broadcast (US-EVT-14) — turning
 * them into their side effects. The ConsumerService discovers each handler via
 * DiscoveryService, so no wiring into the RabbitMQ module is needed; the email
 * handlers send via the EmailProvider port (EmailModule).
 */
@Module({
  providers: [
    EventRecipientsRepository,
    EventPublishedHandler,
    AttendeesEmailHandler,
    EventCancelledHandler,
  ],
})
export class EventsModule {}
