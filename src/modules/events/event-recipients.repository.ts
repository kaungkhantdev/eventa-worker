import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import {
  CONFIRMED_ORDER_STATUS,
  events,
  orders,
  organizations,
  users,
  type Locale,
} from '../../db/schema';
import { asLocale } from '../../common/messaging/locale';
import { ATTENDEE_PERSONA, PLATFORM_ORG_SLUG } from '../../db/schema/events';

/** When neither the event nor the workspace names a language. */

/** One broadcast recipient — a confirmed attendee's contact. */
export interface Recipient {
  email: string;
  name: string;
}

/** Somebody told an event is off — holding a ticket, or waiting for one. */
export interface CancellationRecipient extends Recipient {
  /**
   * Every registration they have for it is still waiting for the organizer's
   * approval (US-REG-02): no ticket, and possibly money already taken.
   */
  awaitingApproval: boolean;
}

/** Pending, with its decision asked for, is waiting on the organizer. */
const PENDING_ORDER_STATUS = 'pending';

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

  /**
   * Everybody a cancellation must reach (US-EVT-08): the confirmed attendees,
   * and the registrations still waiting for the organizer's approval
   * (US-REG-02) — paid for or free, they were promised a decision, and a paid
   * one's money is owed back. Not an order still waiting for its money, which
   * holds nothing yet, nor one already turned down. Distinct by buyer email;
   * somebody holding a ticket as well as a waiting registration is written to
   * as a ticket holder.
   */
  async cancellationRecipients(
    organizationId: number,
    eventId: string,
  ): Promise<CancellationRecipient[]> {
    const rows = await this.db
      .select({
        email: orders.buyerEmail,
        name: sql<string>`max(${orders.buyerName})`,
        awaitingApproval: sql<boolean>`bool_and(${orders.status} = ${PENDING_ORDER_STATUS})`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, organizationId),
          eq(orders.eventId, eventId),
          isNull(orders.deletedAt),
          or(
            eq(orders.status, CONFIRMED_ORDER_STATUS),
            and(
              eq(orders.status, PENDING_ORDER_STATUS),
              isNotNull(orders.approvalRequestedAt),
            ),
          ),
        ),
      )
      .groupBy(orders.buyerEmail);
    return rows.map((r) => ({
      email: r.email,
      name: r.name,
      awaitingApproval: r.awaitingApproval,
    }));
  }

  /**
   * Each recipient's own language, for those with an attendee account — in
   * ONE query for the whole batch rather than one per person.
   *
   * Attendee accounts live in the PLATFORM organization, not the organizer's
   * workspace, so that one person's tickets can span organizers. Scoping this
   * to the organizer's org would find nobody; dropping the persona filter would
   * match the organizer's own staff row for the same address, when somebody
   * buys a ticket to their own event.
   *
   * Somebody with no account is simply absent from the map, and the caller
   * falls back to the event's language — the next thing that knows.
   */
  async attendeeLocales(emails: string[]): Promise<Map<string, Locale>> {
    if (emails.length === 0) return new Map();
    const rows = await this.db
      .select({ email: users.email, locale: users.locale })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(
        and(
          inArray(users.email, emails),
          eq(users.persona, ATTENDEE_PERSONA),
          eq(organizations.slug, PLATFORM_ORG_SLUG),
          isNull(users.deletedAt),
        ),
      );
    return new Map(
      rows
        .filter((row): row is { email: string; locale: Locale } =>
          Boolean(row.locale),
        )
        .map((row) => [row.email, row.locale]),
    );
  }

  /**
   * The language to use for somebody whose own preference is unknown: the
   * event's, then the workspace's, then English. The same precedence the
   * registration confirmation uses, so one attendee does not get their ticket
   * in Thai and their cancellation in English.
   */
  async fallbackLocale(
    organizationId: number,
    eventId: string,
  ): Promise<Locale> {
    const [row] = await this.db
      .select({ eventLocale: events.locale, orgLocale: organizations.locale })
      .from(events)
      .innerJoin(organizations, eq(organizations.id, events.organizationId))
      .where(
        and(eq(events.id, eventId), eq(events.organizationId, organizationId)),
      )
      .limit(1);
    // `asLocale`, not a bare `??`: the column is typed `Locale` but this
    // service only MIRRORS eventa-api's enum, and Drizzle does not map enum
    // values on the way in — so an upstream `ALTER TYPE` reaches the copy
    // table as a key it does not have. See `common/messaging/locale.ts`.
    return asLocale(row?.eventLocale ?? row?.orgLocale);
  }
}
