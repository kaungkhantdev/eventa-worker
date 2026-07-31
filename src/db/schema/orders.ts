import {
  bigint,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `order_status` enum + the read columns of `orders` the
// worker needs to resolve broadcast / cancellation recipients. eventa-api OWNS the
// schema and migrations; this is only a typed read view of that one table. Keep in
// sync with entities.md.
export const orderStatusEnum = pgEnum('order_status', [
  'confirmed',
  'pending',
  'waitlisted',
  'cancelled',
]);

/** A confirmed order = a live booking whose attendee should receive event messaging. */
export const CONFIRMED_ORDER_STATUS = 'confirmed' as const;

export const orders = pgTable('orders', {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  eventId: uuid().notNull(),
  buyerName: text().notNull(),
  buyerEmail: text().notNull(), // citext in eventa-api; read as text here
  status: orderStatusEnum().notNull(),
  deletedAt: timestamp({ withTimezone: true }),
});
