import {
  bigint,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `seat_holds` — the short-lived reservation a checkout
// takes so nobody else can buy the same seats while the buyer pays. eventa-api
// OWNS the schema and migrations; nothing here creates or alters a table. Keep
// in sync with entities.md.
//
// The worker needs it for two things. `expires_at` is the buyer's real
// deadline, and the expiry sweep both reads it (to find what lapsed) and writes
// it (to retire the dead holds alongside their order). And a lapsed waitlist
// offer's seats are re-held for the next person in line in the same sweep.

export const holdStatusEnum = pgEnum('hold_status', [
  'active',
  'converted',
  'expired',
  'released',
]);

/** Only an active hold reserves anything; the rest are history. */
export const ACTIVE_HOLD = 'active' as const;

export const seatHolds = pgTable('seat_holds', {
  // Identity in eventa-api; declared so here because the sweep now INSERTS a
  // hold when it passes a lapsed waitlist offer on (US-REG-04).
  id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  eventId: uuid().notNull(),
  /** Null until a checkout converts the hold into an order. */
  orderId: uuid(),
  ticketTypeId: uuid(),
  seatId: bigint({ mode: 'number' }),
  quantity: integer().notNull(),
  status: holdStatusEnum().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});
