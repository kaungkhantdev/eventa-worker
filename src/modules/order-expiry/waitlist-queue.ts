import { and, asc, eq, gt, sql } from 'drizzle-orm';
import {
  ACTIVE_HOLD,
  orderItems,
  orders,
  outboxEvents,
  seatHolds,
  ticketTypes,
} from '../../db/schema';
import type { Tx } from '../../db/tenant';
import {
  type OutboxEvent,
  type WaitlistEntryRef,
  offerExpiredEvent,
  payUrlFor,
  waitlistOfferedEvent,
} from '../waitlist/waitlist-events';

/** An allocation of 0 means unlimited — mirrors eventa-api's `TicketingPolicy`. */
const UNLIMITED = 0;
const WAITLISTED = 'waitlisted' as const;

/** An offer the sweep just closed, with the ticket it was for. */
export interface LapsedOffer extends WaitlistEntryRef {
  ticketTypeId: string;
}

export interface PassOnSettings {
  now: Date;
  /** How long a passed-on offer lasts. */
  offerMs: number;
  /** Null: no pay link can be written, so nothing is passed on. */
  publicWebUrl: string | null;
}

/** Settings once there is somewhere to link an offer to. */
type LinkableSettings = PassOnSettings & { publicWebUrl: string };

/**
 * What an unpaid waitlist offer lapsing means (US-REG-04): "the seat passes
 * to the next person in line automatically and the attendee is told their
 * offer expired".
 *
 * Runs INSIDE the expiry sweep's transaction, after the lapsed offers are
 * `expired` and their holds retired. That is the point: the freed seats are
 * re-held for whoever is next before the transaction commits, so there is no
 * moment in which they are back on public sale ahead of the people waiting
 * for them. Both emails go through the outbox in the same transaction, so an
 * offer and the message about it commit or roll back together.
 *
 * Returns the references it offered seats to.
 */
export async function settleLapsedOffers(
  tx: Tx,
  lapsed: LapsedOffer[],
  settings: PassOnSettings,
): Promise<string[]> {
  for (const offer of lapsed) {
    await enqueue(
      tx,
      offerExpiredEvent({ ...offer, occurredAt: settings.now }),
    );
  }
  const { publicWebUrl } = settings;
  if (!publicWebUrl) return [];
  const offered: string[] = [];
  for (const tier of distinctTiers(lapsed)) {
    offered.push(...(await passOn(tx, tier, { ...settings, publicWebUrl })));
  }
  return offered;
}

interface TierRef {
  organizationId: number;
  ticketTypeId: string;
}

/**
 * Offer whatever is free on one ticket to the people waiting for it, in
 * order, for as long as the next one fits.
 *
 * Strictly in line: when the person at the front wants more seats than are
 * free, nobody behind them is offered instead. Jumping them would be the
 * out-of-order choice the story says an ORGANIZER may make and must be
 * recorded — not one a timer makes silently.
 *
 * The ticket row is locked first, as the seat-hold engine locks it, and what
 * is free is its own sum: allocation, less sold, less every hold still live.
 */
async function passOn(
  tx: Tx,
  tier: TierRef,
  settings: LinkableSettings,
): Promise<string[]> {
  const [row] = await tx
    .select({
      eventId: ticketTypes.eventId,
      name: ticketTypes.name,
      sold: ticketTypes.sold,
      total: ticketTypes.total,
    })
    .from(ticketTypes)
    .where(
      and(
        eq(ticketTypes.id, tier.ticketTypeId),
        eq(ticketTypes.organizationId, tier.organizationId),
      ),
    )
    .for('update');
  if (!row || row.total === UNLIMITED) return [];

  const offered: string[] = [];
  for (;;) {
    const free = row.total - row.sold - (await heldFor(tx, tier, settings.now));
    const next = await nextInLine(tx, tier);
    if (!next || next.seats > free) return offered;
    await offerSeats(tx, next, { ...tier, ...row }, settings);
    offered.push(next.reference);
  }
}

async function heldFor(tx: Tx, tier: TierRef, now: Date): Promise<number> {
  const [row] = await tx
    .select({
      held: sql<number>`coalesce(sum(${seatHolds.quantity}), 0)::int`,
    })
    .from(seatHolds)
    .where(
      and(
        eq(seatHolds.organizationId, tier.organizationId),
        eq(seatHolds.ticketTypeId, tier.ticketTypeId),
        eq(seatHolds.status, ACTIVE_HOLD),
        gt(seatHolds.expiresAt, now),
      ),
    );
  return row.held;
}

/**
 * The front of the line: first come, first served by when they joined, the id
 * breaking a tie — the order eventa-api shows the organizer. Locked, and a
 * row somebody else holds is skipped rather than waited on: an organizer
 * offering that person a seat right now is already doing this job.
 */
async function nextInLine(tx: Tx, tier: TierRef) {
  const [next] = await tx
    .select({
      id: orders.id,
      reference: orders.reference,
      eventId: orders.eventId,
      buyerEmail: orders.buyerEmail,
      buyerName: orders.buyerName,
      seats: orders.seats,
      totalSatang: orders.totalSatang,
      currency: orders.currency,
    })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.organizationId, tier.organizationId),
        eq(orders.status, WAITLISTED),
        eq(orderItems.ticketTypeId, tier.ticketTypeId),
      ),
    )
    .orderBy(asc(orders.registeredAt), asc(orders.id))
    .limit(1)
    .for('update', { of: orders, skipLocked: true });
  return next ?? null;
}

type NextInLine = NonNullable<Awaited<ReturnType<typeof nextInLine>>>;

async function offerSeats(
  tx: Tx,
  next: NextInLine,
  tier: TierRef & { name: string },
  settings: LinkableSettings,
): Promise<void> {
  const offerExpiresAt = new Date(settings.now.getTime() + settings.offerMs);
  await tx.insert(seatHolds).values({
    organizationId: tier.organizationId,
    eventId: next.eventId,
    orderId: next.id,
    ticketTypeId: tier.ticketTypeId,
    quantity: next.seats,
    status: ACTIVE_HOLD,
    expiresAt: offerExpiresAt,
  });
  await tx
    .update(orders)
    .set({
      status: 'pending',
      offeredAt: settings.now,
      // Nobody chose this one: the line did, in order.
      offeredBy: null,
      offerExpiresAt,
      offerSkipped: 0,
      updatedAt: settings.now,
    })
    .where(eq(orders.id, next.id));
  await enqueue(
    tx,
    waitlistOfferedEvent({
      organizationId: tier.organizationId,
      orderId: next.id,
      reference: next.reference,
      eventId: next.eventId,
      buyerEmail: next.buyerEmail,
      buyerName: next.buyerName,
      ticketTypeName: tier.name,
      ticketCount: next.seats,
      totalSatang: next.totalSatang,
      currency: next.currency,
      offerExpiresAt,
      payUrl: payUrlFor(settings.publicWebUrl, next.id),
      occurredAt: settings.now,
    }),
  );
}

async function enqueue(tx: Tx, event: OutboxEvent): Promise<void> {
  await tx.insert(outboxEvents).values(event);
}

function distinctTiers(lapsed: LapsedOffer[]): TierRef[] {
  const seen = new Map<string, TierRef>();
  for (const { organizationId, ticketTypeId } of lapsed) {
    seen.set(`${organizationId}:${ticketTypeId}`, {
      organizationId,
      ticketTypeId,
    });
  }
  return [...seen.values()];
}
