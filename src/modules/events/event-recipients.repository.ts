import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import {
  CONFIRMED_ORDER_STATUS,
  events,
  orders,
  organizations,
  users,
  type Locale,
} from '../../db/schema';
import { ATTENDEE_PERSONA, PLATFORM_ORG_SLUG } from '../../db/schema/events';

/** When neither the event nor the workspace names a language. */
const DEFAULT_LOCALE: Locale = 'en';

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
    return row?.eventLocale ?? row?.orgLocale ?? DEFAULT_LOCALE;
  }
}
