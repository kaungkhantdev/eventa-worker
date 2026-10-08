import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import {
  CANCELLED_ANNOUNCEMENT,
  CANCELLED_EVENT_STATUS,
  CONFIRMED_ORDER_STATUS,
  SCHEDULED_ANNOUNCEMENT,
  SENT_ANNOUNCEMENT,
  announcements,
  events,
  orders,
  outboxEvents,
} from '../../db/schema';
import type { Tx } from '../../db/tenant';
import { attendeesEmailRequestedOutbox } from './announcement-outbox';

/** An announcement the sweep sent. Ids and counts only — never its words. */
export interface SentAnnouncement {
  id: number;
  organizationId: number;
  recipientCount: number;
}

/** A due announcement whose event had gone or been cancelled, so it was called off instead. */
export interface DroppedAnnouncement {
  id: number;
  organizationId: number;
}

export interface DueSweepResult {
  sent: SentAnnouncement[];
  dropped: DroppedAnnouncement[];
}

export interface SendDueInput {
  now: Date;
  limit: number;
}

type DueAnnouncement = Awaited<
  ReturnType<ScheduledAnnouncementsRepository['claimDue']>
>[number];

/**
 * Turns scheduled announcements into sends when they fall due (US-MSG-04/05).
 *
 * Deliberately cross-tenant and therefore without `withTenant`, like the
 * order-expiry sweep: a scheduled job belongs to no workspace. Every row it
 * writes carries the announcement's own `organization_id`, and every read of
 * another table is scoped to it.
 *
 * It is the worker's half of a race with the organizer, who can cancel or move
 * an announcement right up until this claims it. The two are kept apart by row
 * locks alone: this claims with `FOR UPDATE … SKIP LOCKED`, and eventa-api
 * changes one with a single UPDATE conditioned on `status = 'scheduled'`. So a
 * row the organizer is changing is skipped here (the next sweep sees what they
 * committed), and a change arriving while this holds the row waits, then finds
 * it `sent` and is refused. Whichever commits first wins; nothing goes twice
 * and nothing cancelled goes at all.
 */
@Injectable()
export class ScheduledAnnouncementsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Send every due announcement in one batch.
   *
   * ONE transaction: the status change and the outbox row that delivers it
   * commit together or not at all — the same guarantee the API gives a
   * send-now. Idempotent by construction: it selects by status and holds no
   * cursor, so a second sweep (or one racing this) finds nothing left to do.
   */
  async sendDue(input: SendDueInput): Promise<DueSweepResult> {
    return this.db.transaction(async (tx) => {
      const result: DueSweepResult = { sent: [], dropped: [] };
      for (const due of await this.claimDue(tx, input)) {
        if (due.eventLive) {
          result.sent.push(await this.send(tx, due, input.now));
        } else {
          result.dropped.push(await this.drop(tx, due, input.now));
        }
      }
      return result;
    });
  }

  /**
   * The due announcements nobody else is holding, oldest first, locked.
   *
   * `FOR UPDATE OF announcements`: Postgres will not lock the nullable side of
   * an outer join, and the event is only read — it is the announcement row the
   * organizer's cancel competes for.
   *
   * Left-joined to events on the organization too, so an announcement can never
   * be matched to another workspace's event. An event that is missing,
   * soft-deleted or CANCELLED is "not live": its attendees have already been
   * told it is off (eventa-api fans that out on cancellation), and the words
   * waiting here were written while it was still going ahead.
   */
  private claimDue(tx: Tx, input: SendDueInput) {
    return tx
      .select({
        id: announcements.id,
        organizationId: announcements.organizationId,
        eventId: announcements.eventId,
        subject: announcements.subject,
        body: announcements.body,
        sentByUserId: announcements.sentByUserId,
        eventLive: sql<boolean>`(${events.id} IS NOT NULL AND ${events.deletedAt} IS NULL
                                 AND ${events.status} <> ${CANCELLED_EVENT_STATUS})`,
      })
      .from(announcements)
      .leftJoin(
        events,
        and(
          eq(events.id, announcements.eventId),
          eq(events.organizationId, announcements.organizationId),
        ),
      )
      .where(
        and(
          eq(announcements.status, SCHEDULED_ANNOUNCEMENT),
          lte(announcements.scheduledFor, input.now),
        ),
      )
      .orderBy(asc(announcements.scheduledFor), asc(announcements.id))
      .limit(input.limit)
      .for('update', { of: announcements, skipLocked: true });
  }

  /**
   * Mark it sent and queue the send, counting the audience as it is NOW — the
   * "freshly resolved audience" a rescheduled one is promised (US-MSG-05).
   */
  private async send(
    tx: Tx,
    due: DueAnnouncement,
    now: Date,
  ): Promise<SentAnnouncement> {
    const recipientCount = await this.attendeeCount(tx, due);
    // Locked since the claim, so it is still `scheduled`.
    await tx
      .update(announcements)
      .set({
        status: SENT_ANNOUNCEMENT,
        sentAt: now,
        recipientCount,
        updatedAt: now,
      })
      .where(eq(announcements.id, due.id));
    await tx.insert(outboxEvents).values(
      attendeesEmailRequestedOutbox({
        organizationId: due.organizationId,
        eventId: due.eventId,
        subject: due.subject,
        body: due.body,
        requestedByUserId: due.sentByUserId,
        recipientCount,
        occurredAt: now,
      }),
    );
    return { id: due.id, organizationId: due.organizationId, recipientCount };
  }

  /**
   * Call off one whose event is gone or cancelled. A send-now to a deleted
   * event is a 404; sending it later anyway would write to the attendees of an
   * event the organizer took down. A cancelled event's attendees have already
   * had the cancellation email, and this was composed before it — the organizer
   * never chose to send it *after* calling the event off. (Writing to them on
   * purpose is still possible: a send-now names its words at the time it goes.)
   * `cancelled_by_user_id` stays null: nobody did.
   */
  private async drop(
    tx: Tx,
    due: DueAnnouncement,
    now: Date,
  ): Promise<DroppedAnnouncement> {
    await tx
      .update(announcements)
      .set({ status: CANCELLED_ANNOUNCEMENT, cancelledAt: now, updatedAt: now })
      .where(eq(announcements.id, due.id));
    return { id: due.id, organizationId: due.organizationId };
  }

  /**
   * Distinct confirmed attendees — eventa-api's `attendeeCount`, and who the
   * handler will write to. Keep the three in step.
   */
  private async attendeeCount(tx: Tx, due: DueAnnouncement): Promise<number> {
    const [{ total }] = await tx
      .select({
        total: sql<number>`count(distinct ${orders.buyerEmail})::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, due.organizationId),
          eq(orders.eventId, due.eventId),
          eq(orders.status, CONFIRMED_ORDER_STATUS),
          isNull(orders.deletedAt),
        ),
      );
    return total;
  }
}
