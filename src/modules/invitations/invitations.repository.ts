import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { events } from '../../db/schema';
import { CANCELLED_EVENT_STATUS } from '../../db/schema/events';

/** The event an invitation is to, as it stands now rather than when it was written. */
export interface InvitationEvent {
  /** The workspace that owns the event — and so the invitation. */
  organizationId: number;
  eventName: string;
  startAt: Date;
  timezone: string;
  /** Read as text, like everywhere else in this service; see db/schema/events. */
  status: string;
}

/**
 * Read access for the invitation email. eventa-api owns `events`; this only
 * reads, and writes nothing — `event_invitations` has no delivery column for a
 * consumer to update (its `sent_at` is written by the API when the invite is
 * recorded, in the same transaction as the outbox row), and the record of what
 * became of the mail goes to `message_deliveries` through the email provider.
 */
@Injectable()
export class InvitationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The event being invited to, or null if it has been deleted.
   *
   * **This is the one query in this service with no `organization_id`
   * predicate, and it is deliberate: resolving the tenant is its whole job.**
   * `invitation.sent` is the only event eventa-api publishes without
   * `organizationId` on the payload — it sits on the outbox row, and the relay
   * ships the payload alone — so there is no tenant to scope by until this
   * read returns one. `events.id` is a UUID primary key, globally unique and
   * not guessable, so there is nothing for a predicate to disambiguate; every
   * read and write that follows is scoped by the workspace it returns.
   *
   * The better fix is upstream: eventa-api adding `organizationId` to the
   * payload, as all fifteen of its other events do. Until then this read also
   * earns its place twice over — it is what tells the handler the event's
   * CURRENT name, start and status, so nobody is invited to an event that has
   * since been cancelled, or invited under a name it no longer has.
   */
  async invitedEvent(eventId: string): Promise<InvitationEvent | null> {
    const [row] = await this.db
      .select({
        organizationId: events.organizationId,
        eventName: events.name,
        startAt: events.startAt,
        timezone: events.timezone,
        status: events.status,
      })
      .from(events)
      .where(and(eq(events.id, eventId), isNull(events.deletedAt)))
      .limit(1);
    return row ?? null;
  }
}

/** Whether an invitation to this event should still go out at all. */
export function stillInvitable(event: InvitationEvent): boolean {
  return event.status !== CANCELLED_EVENT_STATUS;
}
