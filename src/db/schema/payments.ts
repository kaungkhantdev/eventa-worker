import {
  bigint,
  boolean,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { paymentStatusEnum } from './orders';

// MIRROR of eventa-api's `payments`, `payment_settings`, `order_items` and
// `ticket_types` — only what the payment receipt reads. eventa-api OWNS the
// schema and migrations; nothing here is written.

/** A payment that actually took the money — the only kind a receipt is for. */
export const PAID_PAYMENT_STATUS = 'paid' as const;

export const payments = pgTable('payments', {
  id: uuid().primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  orderId: uuid().notNull(),
  /** Read as text: printed as stored (`Card`, `PromptPay`, …), never branched on. */
  method: text().notNull(),
  status: paymentStatusEnum().notNull(),
  paidAt: timestamp({ withTimezone: true }),
});

export const paymentSettings = pgTable('payment_settings', {
  id: bigint({ mode: 'number' }).primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  /** US-SET-10's "email receipts"; no row at all means the default, on. */
  emailReceipts: boolean().notNull(),
});

export const orderItems = pgTable('order_items', {
  id: bigint({ mode: 'number' }).primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  orderId: uuid().notNull(),
  ticketTypeId: uuid().notNull(),
  quantity: smallint().notNull(),
  unitPriceSatang: bigint({ mode: 'number' }).notNull(),
  lineSubtotalSatang: bigint({ mode: 'number' }).notNull(),
});

export const ticketTypes = pgTable('ticket_types', {
  id: uuid().primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  eventId: uuid().notNull(),
  name: text().notNull(),
  // Read under a row lock when a lapsed waitlist offer is passed on: what is
  // free is `total − sold − active holds`, the seat-hold engine's own sum.
  sold: integer().notNull(),
  /** Allocation; 0 means unlimited — which never sells out, so has no queue. */
  total: integer().notNull(),
});
