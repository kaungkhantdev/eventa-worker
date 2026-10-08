import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { messageDeliveries } from '../../db/schema';
import type { MessageChannel } from '../../db/schema/messaging';
import { withTenant } from '../../db/tenant';

/** What became of one message. See the schema note on why there are only two. */
export type DeliveryStatus = 'sent' | 'failed';

export interface DeliveryRecord {
  organizationId: number;
  /**
   * How it left. REQUIRED rather than left to the column's default: now that
   * texts are logged beside email, a row that inherited 'email' from the
   * database would tell an organizer chasing a missing ticket the wrong story.
   */
  channel: MessageChannel;
  kind: string;
  /**
   * The person's ADDRESS, even on a text — the column is NOT NULL and there is
   * no phone column, so a texted row is filed under the same person as their
   * email. The number itself is never stored.
   */
  recipientEmail: string;
  recipientName: string | null;
  eventId: string | null;
  status: DeliveryStatus;
  error: string | null;
  sentAt: Date;
}

/**
 * The delivery log (US-MSG-06). eventa-api owns the table; this only writes.
 *
 * One row per recipient, written as the message goes out — which is the only
 * moment anything knows whether the transport took it.
 */
@Injectable()
export class MessageDeliveriesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async record(entry: DeliveryRecord): Promise<void> {
    await withTenant(this.db, entry.organizationId, async (tx) => {
      await tx.insert(messageDeliveries).values(entry);
    });
  }
}
