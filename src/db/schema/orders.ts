import {
  bigint,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `order_status` / `payment_status` enums and the columns
// of `orders` this worker touches. eventa-api OWNS the schema and migrations;
// nothing here creates or alters a table. Keep in sync with entities.md.
//
// NOTE — this is no longer a read-only view. The expiry sweep WRITES `status`
// and `updated_at` (see modules/order-expiry), which raises the cost of drift.
// A missing enum value used to be invisible, because a read never produced one;
// a write can fail on it. Both `rejected` and `expired` were absent here for
// exactly that reason — added in eventa-api, unnoticed here.
export const orderStatusEnum = pgEnum('order_status', [
  'confirmed',
  'pending',
  'waitlisted',
  'cancelled',
  /** An organizer turned the registration down (US-REG-02). */
  'rejected',
  /** The seat hold lapsed before the money arrived — what the sweep writes. */
  'expired',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'paid',
  'pending',
  'refunded',
  'failed',
]);

/** A confirmed order = a live booking whose attendee should receive event messaging. */
export const CONFIRMED_ORDER_STATUS = 'confirmed' as const;

export const orders = pgTable('orders', {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  /** The human-facing number — what an organizer is asked about, unlike the id. */
  reference: text().notNull(),
  eventId: uuid().notNull(),
  buyerName: text().notNull(),
  buyerEmail: text().notNull(), // citext in eventa-api; read as text here
  status: orderStatusEnum().notNull(),
  paymentStatus: paymentStatusEnum().notNull(),
  seats: integer().notNull(), // smallint in eventa-api
  /** When they joined — the waitlist is first come, first served by this. */
  registeredAt: timestamp({ withTimezone: true }).notNull(),
  // A waitlist offer (US-REG-04). The expiry sweep WRITES these when it passes
  // a lapsed offer on: `offeredBy` null says the queue did it, not a person.
  offeredAt: timestamp({ withTimezone: true }),
  offeredBy: uuid(),
  offerExpiresAt: timestamp({ withTimezone: true }),
  // `smallint`, matching eventa-api exactly, unlike the widened `seats` and
  // `currency` above: those are only ever READ here, where int4-for-int2 and
  // text-for-char(3) are indistinguishable, but the sweep WRITES this one. A
  // write is where a mirror's type stops being cosmetic, so this column is the
  // one that has to be the real thing.
  offerSkipped: smallint(),
  // When the order started waiting for the organizer's approval (US-REG-02).
  // Pending with this set is on the ORGANIZER's clock, not the buyer's: the
  // expiry sweep reads it only to leave such an order alone.
  approvalRequestedAt: timestamp({ withTimezone: true }),
  // The money as checkout recorded it, read by the payment receipt. Integer
  // satang, VAT included; the fee is not stored — see `serviceFeeOf`.
  subtotalSatang: bigint({ mode: 'number' }).notNull(),
  discountAmountSatang: bigint({ mode: 'number' }).notNull(),
  vatAmountSatang: bigint({ mode: 'number' }).notNull(),
  totalSatang: bigint({ mode: 'number' }).notNull(),
  currency: text().notNull(), // char(3) in eventa-api
  updatedAt: timestamp({ withTimezone: true }).notNull(),
  deletedAt: timestamp({ withTimezone: true }),
});
