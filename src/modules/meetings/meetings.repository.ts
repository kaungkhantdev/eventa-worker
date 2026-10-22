import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { type MeetingSyncStatus, meetings } from '../../db/schema';
import { withTenant } from '../../db/tenant';

/** The meeting as the sync reads it — deleted rows included. */
export type MeetingForSync = typeof meetings.$inferSelect;

/**
 * What the sync writes back. Never `pending` (that is eventa-api's), and
 * never `version` or `updated_at` — those belong to the organizer's edits.
 */
export interface SyncOutcomePatch {
  syncStatus: Exclude<MeetingSyncStatus, 'pending'>;
  /** One of the fixed sentences, or null. Never vendor text. */
  syncError: string | null;
  /** Present only when the sync decided the link; absent leaves it alone. */
  link?: string | null;
}

/**
 * The meetings row, for the calendar sync (US-MTG-04..08) — the ADR-15 write
 * exception: an external outcome written back onto an eventa-api aggregate.
 *
 * Every query runs inside `withTenant` AND carries an explicit
 * `organization_id` predicate beside the meeting id, so the message's
 * organization is only ever trusted together with the meeting it names.
 */
@Injectable()
export class MeetingsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** The current row, deleted or not — the sync works from this, never the message. */
  findForSync(
    organizationId: number,
    meetingId: string,
  ): Promise<MeetingForSync | null> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.id, meetingId),
            eq(meetings.organizationId, organizationId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * Record the outcome — but only if the row is still the one the sync read.
   *
   * eventa-api moves `updated_at` on every write, so a meeting the organizer
   * changed mid-sync matches nothing here: false, and the newer message that
   * change enqueued owns the outcome. This service never moves `updated_at`
   * itself, so its own writes never supersede each other.
   */
  writeOutcome(
    organizationId: number,
    meetingId: string,
    seenUpdatedAt: string,
    patch: SyncOutcomePatch,
  ): Promise<boolean> {
    return withTenant(this.db, organizationId, async (tx) => {
      const written = await tx
        .update(meetings)
        .set(patch)
        .where(
          and(
            eq(meetings.id, meetingId),
            eq(meetings.organizationId, organizationId),
            eq(meetings.updatedAt, seenUpdatedAt),
          ),
        )
        .returning({ id: meetings.id });
      return written.length > 0;
    });
  }

  /**
   * The Google event id, UNCONDITIONALLY. eventa-api never writes this column,
   * so no organizer edit can conflict with it — and dropping it on a
   * superseded sync would leave an invite on the guest's calendar that a later
   * cancel could not name. Only an actual change is written.
   */
  async recordExternalId(
    organizationId: number,
    meetingId: string,
    eventId: string,
  ): Promise<void> {
    await withTenant(this.db, organizationId, (tx) =>
      tx
        .update(meetings)
        .set({ externalEventId: eventId })
        .where(
          and(
            eq(meetings.id, meetingId),
            eq(meetings.organizationId, organizationId),
            sql`${meetings.externalEventId} IS DISTINCT FROM ${eventId}`,
          ),
        ),
    );
  }
}
