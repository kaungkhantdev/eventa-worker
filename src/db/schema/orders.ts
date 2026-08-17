import {
  bigint,
  pgEnum,
  pgTable,
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
  updatedAt: timestamp({ withTimezone: true }).notNull(),
  deletedAt: timestamp({ withTimezone: true }),
});
