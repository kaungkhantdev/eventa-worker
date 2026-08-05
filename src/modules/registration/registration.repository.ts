import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import {
  events,
  messageTemplates,
  organizations,
  tickets,
  users,
  type Locale,
} from '../../db/schema';
import { LIVE_TICKET_STATUSES } from '../../db/schema/tickets';
import { ATTENDEE_PERSONA, PLATFORM_ORG_SLUG } from '../../db/schema/events';
import { withTenant, type Tx } from '../../db/tenant';
import type { ConfirmationTicket } from './confirmation-email';

export interface ConfirmationEvent {
  name: string;
  startAt: Date;
  timezone: string;
  venueName: string | null;
  city: string | null;
  isOnline: boolean;
  onlineNote: string | null;
  slug: string;
  locale: Locale | null;
}

/** Everything the confirmation email needs that the message did not carry. */
export interface ConfirmationSource {
  event: ConfirmationEvent;
  orgLocale: Locale;
  /** The buyer's own preference, when they have a portal account. */
  userLocale: Locale | null;
  tickets: ConfirmationTicket[];
}

/**
 * Read access for the confirmation email. eventa-api owns these tables; this is
 * a read view of them, and every query runs inside `withTenant` because they are
 * all RLS-scoped — an unscoped read returns no rows rather than failing, which
 * would quietly produce an email with no tickets in it.
 */
@Injectable()
export class RegistrationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Whether the organizer has this automated message switched on. An ABSENT row
   * means active: a workspace that has never opened its message settings must
   * still send confirmations.
   */
  async isMessageActive(
    organizationId: number,
    slug: string,
  ): Promise<boolean> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({ active: messageTemplates.active })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.organizationId, organizationId),
            eq(messageTemplates.slug, slug),
          ),
        )
        .limit(1);
      return row?.active ?? true;
    });
  }

  async loadConfirmation(
    organizationId: number,
    orderId: string,
    eventId: string,
    buyerEmail: string,
  ): Promise<ConfirmationSource | null> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [event] = await tx
        .select({
          name: events.name,
          startAt: events.startAt,
          timezone: events.timezone,
          venueName: events.venueName,
          city: events.city,
          isOnline: events.isOnline,
          onlineNote: events.onlineNote,
          slug: events.slug,
          locale: events.locale,
        })
        .from(events)
        .where(
          and(
            eq(events.id, eventId),
            eq(events.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!event) return null;
      return {
        event,
        orgLocale: await this.orgLocale(tx, organizationId),
        userLocale: await this.attendeeLocale(tx, buyerEmail),
        tickets: await this.liveTickets(tx, organizationId, orderId),
      };
    });
  }

  /**
   * The buyer's own language, when they have an attendee account.
   *
   * Attendee accounts do NOT live in the organizer's workspace — every
   * `persona = 'attendee'` user belongs to the single platform organization, so
   * that one person's tickets can span organizers. Scoping this lookup to the
   * organizer's org (the transaction we are inside) would therefore find
   * nothing, and dropping the persona filter would match the ORGANIZER's own
   * staff row for the same address: an organizer who buys a ticket to their own
   * event has two rows, and an unordered `limit 1` would pick either.
   */
  private async attendeeLocale(tx: Tx, email: string): Promise<Locale | null> {
    const [row] = await tx
      .select({ locale: users.locale })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(
        and(
          eq(users.email, email),
          eq(users.persona, ATTENDEE_PERSONA),
          eq(organizations.slug, PLATFORM_ORG_SLUG),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    return row?.locale ?? null;
  }

  private async orgLocale(tx: Tx, organizationId: number): Promise<Locale> {
    const [row] = await tx
      .select({ locale: organizations.locale })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return row?.locale ?? 'en';
  }

  /** Only tickets that still admit someone — a voided one must not be printed. */
  private async liveTickets(
    tx: Tx,
    organizationId: number,
    orderId: string,
  ): Promise<ConfirmationTicket[]> {
    return tx
      .select({
        holderName: tickets.holderName,
        ticketLabel: tickets.ticketLabel,
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.orderId, orderId),
          eq(tickets.organizationId, organizationId),
          inArray(tickets.status, [...LIVE_TICKET_STATUSES]),
          isNull(tickets.deletedAt),
        ),
      )
      .orderBy(asc(tickets.id));
  }
}
