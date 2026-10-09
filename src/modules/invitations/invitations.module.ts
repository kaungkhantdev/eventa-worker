import { Module } from '@nestjs/common';
import { EmailModule } from '../../common/email/email.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { EventsModule } from '../events/events.module';
import { InvitationSentHandler } from './invitation-sent.handler';
import { InvitationsRepository } from './invitations.repository';

/**
 * Invitations (mirrors eventa-api's `invitations` context): consumes
 * `invitation.sent` and turns an organizer's invitation into the email it was
 * always meant to be (US-REG-06).
 *
 * `EventsModule` is imported for `EventRecipientsRepository` — an invitee with
 * an attendee account reads this mail in the language they read every other
 * message about the event in.
 *
 * What this module does NOT do: write `event_invitations`. That table has no
 * delivery state for a consumer to keep; eventa-api records the invite and its
 * outbox row in one transaction, and what became of the MAIL is the delivery
 * log's business (US-MSG-06), written by the email provider.
 */
@Module({
  imports: [EmailModule, IdempotencyModule, EventsModule],
  providers: [InvitationsRepository, InvitationSentHandler],
})
export class InvitationsModule {}
