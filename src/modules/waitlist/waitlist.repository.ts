import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { events, orders } from '../../db/schema';
import { withTenant } from '../../db/tenant';
import type { OfferState } from './waitlist-notice';

/** What a waitlist email needs that the message did not carry. */
export interface WaitlistContext extends OfferState {
  eventName: string;
  timezone: string;
}

/**
 * Read access for the waitlist emails. eventa-api owns these tables; every
 * query carries its own `organization_id` predicate — `withTenant` is defence
 * in depth, not the boundary (see `db/tenant.ts`).
 */
@Injectable()
export class WaitlistRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** The event, and where the order stands NOW — not when the message was written. */
  async context(
    organizationId: number,
    orderId: string,
  ): Promise<WaitlistContext | null> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({
          eventName: events.name,
          timezone: events.timezone,
          status: orders.status,
          paymentStatus: orders.paymentStatus,
          offerExpiresAt: orders.offerExpiresAt,
        })
        .from(orders)
        .innerJoin(events, eq(events.id, orders.eventId))
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.organizationId, organizationId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }
}
