import { Inject, Injectable } from '@nestjs/common';
import {
  type SQL,
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
} from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { ACTIVE_HOLD, orderItems, orders, seatHolds } from '../../db/schema';
import type { Tx } from '../../db/tenant';
import {
  type LapsedOffer,
  type PassOnSettings,
  settleLapsedOffers,
} from './waitlist-queue';

/**
 * Still on the buyer's checkout clock: placed, unpaid, and not waiting for an
 * organizer's approval (US-REG-02).
 */
function stillUnpaid(): SQL | undefined {
  return and(
    eq(orders.status, 'pending'),
    eq(orders.paymentStatus, 'pending'),
    isNull(orders.approvalRequestedAt),
    isNull(orders.deletedAt),
  );
}

function nothingSwept(): SweepResult {
  return { closed: [], lapsedOffers: 0, offered: [] };
}

/** An order the sweep closed — enough to say so, and nothing more. */
export interface ExpiredOrder {
  id: string;
  organizationId: number;
  reference: string;
}

export interface ExpireInput {
  now: Date;
  graceMs: number;
  limit: number;
  /** How a lapsed waitlist offer is passed on (US-REG-04). */
  waitlist: Omit<PassOnSettings, 'now'>;
}

/** What one sweep did. */
export interface SweepResult {
  closed: ExpiredOrder[];
  /** How many of those were waitlist offers nobody took up. */
  lapsedOffers: number;
  /** References the freed seats were offered to, in line order. */
  offered: string[];
}

/**
 * The one place this worker WRITES an order's lifecycle.
 *
 * Deliberately cross-tenant and therefore deliberately without `withTenant`: a
 * maintenance sweep belongs to no workspace, and scoping it to one would mean
 * either enumerating every organization or missing most of them. Every other
 * read in this service carries an explicit `organization_id` predicate because
 * it acts on behalf of one tenant; this one acts on behalf of none.
 */
@Injectable()
export class OrderExpiryRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Close the orders whose hold lapsed and whose money never came.
   *
   * Only orders that HAVE a hold: the join is the proof that a deadline existed
   * and passed. A pending order with no hold was never on the checkout clock —
   * an organizer entered it by hand (US-REG-03) — and expiring it would delete
   * somebody's work on a timer they never agreed to.
   *
   * `max(expires_at)` because every hold has to survive for the order to be
   * honoured; the last one to die is the real deadline. `payment_status` must
   * still be pending — a `failed` attempt is a buyer who can retry or switch
   * method, and their seats stay theirs until the TTL runs out on its own.
   *
   * An order awaiting the organizer's approval (US-REG-02) is on nobody's
   * checkout clock: a paid one has paid, a free one owes nothing, and closing
   * it would throw away a decision nobody has made yet.
   *
   * The UPDATE repeats the whole condition rather than trusting the SELECT.
   * Under READ COMMITTED, Postgres re-checks an UPDATE's WHERE once it has
   * waited for the row's lock — so a payment that settled the order between
   * the two statements (confirming it, or leaving it awaiting approval) is no
   * longer overwritten with `expired`. Only the rows it actually closed go on.
   *
   * One transaction, so an order and its holds never disagree about whether it
   * is over. Idempotent by construction: it selects by the data and holds no
   * cursor, so a second sweep racing the first simply finds nothing.
   */
  async expireLapsed(input: ExpireInput): Promise<SweepResult> {
    const deadline = new Date(input.now.getTime() - input.graceMs);
    return this.db.transaction(async (tx) => {
      const lapsed = await tx
        .select({ id: orders.id })
        .from(orders)
        .innerJoin(seatHolds, eq(seatHolds.orderId, orders.id))
        .where(stillUnpaid())
        .groupBy(orders.id)
        .having(lt(max(seatHolds.expiresAt), deadline))
        .limit(input.limit);
      if (lapsed.length === 0) return nothingSwept();

      const closed = await tx
        .update(orders)
        .set({ status: 'expired', updatedAt: input.now })
        .where(
          and(
            inArray(
              orders.id,
              lapsed.map((order) => order.id),
            ),
            stillUnpaid(),
          ),
        )
        .returning({
          id: orders.id,
          organizationId: orders.organizationId,
          reference: orders.reference,
        });
      if (closed.length === 0) return nothingSwept();
      const ids = closed.map((order) => order.id);
      // The holds go with them. They stopped reserving anything the moment they
      // lapsed — availability filters on `expires_at` — but leaving them
      // `active` means the table never stops growing and every count of live
      // holds is a lie.
      await tx
        .update(seatHolds)
        .set({ status: 'expired' })
        .where(
          and(
            inArray(seatHolds.orderId, ids),
            eq(seatHolds.status, ACTIVE_HOLD),
          ),
        );
      // Last, so the seats the lapsed offers held are already free again when
      // the next people in line are offered them — in this same transaction.
      const offers = await this.lapsedOffers(tx, ids);
      const offered =
        offers.length > 0
          ? await settleLapsedOffers(tx, offers, {
              now: input.now,
              ...input.waitlist,
            })
          : [];
      return { closed, lapsedOffers: offers.length, offered };
    });
  }

  /** Which of the closed orders were waitlist offers, and for which ticket. */
  private lapsedOffers(tx: Tx, ids: string[]): Promise<LapsedOffer[]> {
    return tx
      .select({
        orderId: orders.id,
        organizationId: orders.organizationId,
        reference: orders.reference,
        eventId: orders.eventId,
        buyerEmail: orders.buyerEmail,
        buyerName: orders.buyerName,
        ticketTypeId: orderItems.ticketTypeId,
      })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(and(inArray(orders.id, ids), isNotNull(orders.offerExpiresAt)));
  }
}
