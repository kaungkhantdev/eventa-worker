import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { CONFIRMED_ORDER_STATUS, orders } from '../../db/schema';

/** One broadcast recipient — a confirmed attendee's contact. */
export interface Recipient {
  email: string;
  name: string;
}

/**
 * Reads the confirmed-attendee recipient set for an event. eventa-api owns the
 * schema; this only reads `orders`. The definition mirrors eventa-api's Monitor
 * exactly (status = 'confirmed', not soft-deleted, distinct by buyer email) so the
 * worker mails the same people the organizer saw when they hit "Email all".
 */
@Injectable()
export class EventRecipientsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async confirmedRecipients(
    organizationId: number,
    eventId: string,
  ): Promise<Recipient[]> {
    const rows = await this.db
      .select({
        email: orders.buyerEmail,
        name: sql<string>`max(${orders.buyerName})`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, organizationId),
          eq(orders.eventId, eventId),
          eq(orders.status, CONFIRMED_ORDER_STATUS),
          isNull(orders.deletedAt),
        ),
      )
      .groupBy(orders.buyerEmail);
    return rows.map((r) => ({ email: r.email, name: r.name }));
  }
}
