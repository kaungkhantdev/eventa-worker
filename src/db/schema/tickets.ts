import {
  bigint,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `tickets` — the read columns the confirmation email
// prints. eventa-api OWNS the schema and migrations.
export const issuedTicketStatusEnum = pgEnum('issued_ticket_status', [
  'issued',
  'checked_in',
  'void',
  'refunded',
  'transferred',
]);

/** A ticket that still admits someone; void/refunded ones must not be sent. */
export const LIVE_TICKET_STATUSES = ['issued', 'checked_in'] as const;

export const tickets = pgTable('tickets', {
  id: uuid().primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  orderId: uuid().notNull(),
  eventId: uuid().notNull(),
  /** A bearer credential — read at render time, never carried on the bus. */
  qrToken: text().notNull(),
  holderName: text(),
  ticketLabel: text(),
  status: issuedTicketStatusEnum().notNull(),
  deletedAt: timestamp({ withTimezone: true }),
});
