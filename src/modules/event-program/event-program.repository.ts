import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { events } from '../../db/schema';
import { withTenant } from '../../db/tenant';
import type { EventClock } from './session-sitting';

/** What a session-change notice needs about the event the session belongs to. */
export interface EventContext extends EventClock {
  name: string;
  /**
   * Read as text, like `EventRecipientsRepository` does: this only ever asks
   * whether the event has been CANCELLED, and mirroring the whole enum would be
   * one more list to keep in step with eventa-api.
   */
  status: string;
}

/**
 * Read access for the programme notices. eventa-api owns these tables; every
 * query carries its own `organization_id` predicate — `withTenant` is defence
 * in depth, not the boundary (see `db/tenant.ts`).
 */
@Injectable()
export class EventProgramRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The event as it stands NOW, or null when it is gone. Re-read rather than
   * taken off the message: the outbox and the queue can both run behind, and a
   * session move on an event that has since been cancelled — or deleted —
   * must not be announced to anybody.
   */
  async eventContext(
    organizationId: number,
    eventId: string,
  ): Promise<EventContext | null> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({
          name: events.name,
          startAt: events.startAt,
          timezone: events.timezone,
          status: events.status,
        })
        .from(events)
        .where(
          and(
            eq(events.id, eventId),
            eq(events.organizationId, organizationId),
            isNull(events.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }
}
