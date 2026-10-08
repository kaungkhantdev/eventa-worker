import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { activeWhenUnset } from '../../common/messaging/template-defaults';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { eventMessageRuns } from '../../db/schema';
import { EVENT_REMINDER_SLUG } from '../../db/schema/messaging';

/** An event whose attendees are due a scheduled message. */
export interface DueEvent {
  organizationId: number;
  eventId: string;
  eventName: string;
  startAt: Date;
  timezone: string;
  venueName: string | null;
  city: string | null;
  isOnline: boolean;
  onlineNote: string | null;
}

// A type alias, not an interface: `db.execute<T>` wants a Record, and an
// interface has no index signature to satisfy it.
type DueRow = {
  organization_id: string;
  id: string;
  name: string;
  start_at: Date;
  timezone: string;
  venue_name: string | null;
  city: string | null;
  is_online: boolean;
  online_note: string | null;
};

/**
 * Bookkeeping for the messages this service sends on a schedule — the event
 * reminder and the post-event thank-you (US-MSG-01/08).
 *
 * Deliberately cross-tenant, like the order-expiry sweep: a scheduled job
 * belongs to no workspace, and scoping it to one would mean enumerating every
 * organization or missing most of them. Every row it writes still carries the
 * event's own `organization_id`.
 *
 * The "due" queries are literal SQL with every table spelled out, not
 * interpolated columns: Drizzle strips table qualifiers off columns inside a
 * subquery, and an `EXISTS` that quietly compared `event_id` to the wrong
 * table's `id` would email the wrong events without anything failing.
 */
@Injectable()
export class ScheduledMessagesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Events that START within the next `leadMs`, were not cancelled, have not
   * been reminded, and belong to a workspace with the reminder switched on.
   *
   * Only ever forwards: an event that has begun is past being reminded about.
   * An event created at short notice is still reminded, just later — somebody
   * who registered this morning for tonight still wants the time and place.
   *
   * The organizer's switch is applied HERE as well as in `ScheduledSender`,
   * because an off workspace's events are never claimed or completed: left in,
   * they would come back every sweep, sooner-starting first, and fill the
   * batch ahead of workspaces that asked for reminders. The reminder is off
   * until switched on, so that is most workspaces. It is re-read every sweep,
   * so switching it on inside the window still reaches people.
   */
  async remindersDue(input: {
    now: Date;
    leadMs: number;
    limit: number;
  }): Promise<DueEvent[]> {
    const horizon = new Date(input.now.getTime() + input.leadMs);
    const rows = await this.db.execute<DueRow>(sql`
      SELECT e.organization_id, e.id, e.name, e.start_at, e.timezone,
             e.venue_name, e.city, e.is_online, e.online_note
      FROM events e
      WHERE e.start_at > ${input.now}
        AND e.start_at <= ${horizon}
        AND e.status <> 'cancelled'
        AND e.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM event_message_runs r
          WHERE r.event_id = e.id AND r.kind = 'event-reminder'
            AND r.completed_at IS NOT NULL
        )
        AND coalesce(
          (SELECT t.active FROM message_templates t
           WHERE t.organization_id = e.organization_id
             AND t.slug = ${EVENT_REMINDER_SLUG}),
          ${activeWhenUnset(EVENT_REMINDER_SLUG)}::boolean
        )
      ORDER BY e.start_at
      LIMIT ${input.limit}
    `);
    return rows.rows.map(toDueEvent);
  }

  /**
   * Events that ended at least `delay` ago but no more than `window` ago, were
   * not cancelled, have a LIVE survey, and have not been thanked.
   *
   * An event with no end time is measured from its start — it still happened.
   */
  async thankYousDue(input: {
    now: Date;
    delayMs: number;
    windowMs: number;
    limit: number;
  }): Promise<DueEvent[]> {
    const latest = new Date(input.now.getTime() - input.delayMs);
    const earliest = new Date(input.now.getTime() - input.windowMs);
    const rows = await this.db.execute<DueRow>(sql`
      SELECT e.organization_id, e.id, e.name, e.start_at, e.timezone,
             e.venue_name, e.city, e.is_online, e.online_note
      FROM events e
      WHERE coalesce(e.end_at, e.start_at) <= ${latest}
        AND coalesce(e.end_at, e.start_at) >= ${earliest}
        AND e.status <> 'cancelled'
        AND e.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM surveys s
          WHERE s.event_id = e.id AND s.status = 'live'
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_message_runs r
          WHERE r.event_id = e.id AND r.kind = 'post-event-thankyou'
            AND r.completed_at IS NOT NULL
        )
      ORDER BY coalesce(e.end_at, e.start_at)
      LIMIT ${input.limit}
    `);
    return rows.rows.map(toDueEvent);
  }

  /**
   * Record that a run has started. Idempotent: a second run finds the row and
   * carries on, because a crashed run must be resumable.
   */
  async claim(
    event: { organizationId: number; eventId: string },
    kind: string,
    now: Date,
  ): Promise<void> {
    await this.db
      .insert(eventMessageRuns)
      .values({
        organizationId: event.organizationId,
        eventId: event.eventId,
        kind,
        requestedAt: now,
      })
      .onConflictDoNothing({
        target: [eventMessageRuns.eventId, eventMessageRuns.kind],
      });
  }

  /** Everybody was reached — the next run leaves this event alone. */
  async complete(
    event: { organizationId: number; eventId: string },
    kind: string,
    now: Date,
  ): Promise<void> {
    await this.db
      .update(eventMessageRuns)
      .set({ completedAt: now })
      .where(
        and(
          eq(eventMessageRuns.organizationId, event.organizationId),
          eq(eventMessageRuns.eventId, event.eventId),
          eq(eventMessageRuns.kind, kind),
        ),
      );
  }
}

function toDueEvent(row: DueRow): DueEvent {
  return {
    organizationId: Number(row.organization_id),
    eventId: row.id,
    eventName: row.name,
    startAt: new Date(row.start_at),
    timezone: row.timezone,
    venueName: row.venue_name,
    city: row.city,
    isOnline: row.is_online,
    onlineNote: row.online_note,
  };
}
