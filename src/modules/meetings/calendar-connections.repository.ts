import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import {
  CONNECTED_CALENDAR,
  type CalendarConnectionStatus,
  EXPIRED_CALENDAR,
  calendarConnections,
} from '../../db/schema';
import { withTenant } from '../../db/tenant';

/** What the sync needs of the workspace's connection: is it usable, and the token. */
export interface ConnectionForSync {
  status: CalendarConnectionStatus;
  /** Encrypted. Decrypted only into a token request; never logged. */
  refreshTokenCipher: Buffer | null;
}

/**
 * The workspace's Google Calendar connection (US-MTG-08), which eventa-api
 * owns. This service reads it, and writes exactly one thing (ADR-15): marking
 * it `expired` when Google stops accepting the grant.
 *
 * Every query runs inside `withTenant` AND carries an explicit
 * `organization_id` predicate.
 */
@Injectable()
export class CalendarConnectionsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** No row means the workspace never connected. */
  find(organizationId: number): Promise<ConnectionForSync | null> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({
          status: calendarConnections.status,
          refreshTokenCipher: calendarConnections.refreshTokenCipher,
        })
        .from(calendarConnections)
        .where(eq(calendarConnections.organizationId, organizationId))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * Google refused the token this sync used (US-MTG-08 AC3) — but only mark
   * the connection expired if it STILL holds that token. An Admin who
   * reconnected while this sync was in flight stored a new one, and a stale
   * refusal must not undo their reconnect.
   */
  async markExpired(organizationId: number, seenCipher: Buffer): Promise<void> {
    await withTenant(this.db, organizationId, (tx) =>
      tx
        .update(calendarConnections)
        .set({ status: EXPIRED_CALENDAR, updatedAt: sql`now()` })
        .where(
          and(
            eq(calendarConnections.organizationId, organizationId),
            eq(calendarConnections.status, CONNECTED_CALENDAR),
            eq(calendarConnections.refreshTokenCipher, seenCipher),
          ),
        ),
    );
  }
}
