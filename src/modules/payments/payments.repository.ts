import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { events, organizations, type Locale } from '../../db/schema';
import { withTenant } from '../../db/tenant';

/** What the refund notices need beyond the event payload. */
export interface RefundContext {
  eventName: string;
  /** Who to alert; null when the workspace never set a contact address. */
  organizerEmail: string | null;
  locale: Locale;
}

/**
 * Read access for the payment notices. eventa-api owns these tables; every
 * query carries its own `organization_id` predicate rather than relying on the
 * RLS policy, which does not apply to the role this service connects as.
 */
@Injectable()
export class PaymentsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async refundContext(
    organizationId: number,
    eventId: string,
  ): Promise<RefundContext | null> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({
          eventName: events.name,
          contactEmail: events.contactEmail,
          eventLocale: events.locale,
          orgLocale: organizations.locale,
        })
        .from(events)
        .innerJoin(organizations, eq(organizations.id, events.organizationId))
        .where(
          and(
            eq(events.id, eventId),
            eq(events.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        eventName: row.eventName,
        organizerEmail: row.contactEmail,
        locale: row.eventLocale ?? row.orgLocale,
      };
    });
  }
}
