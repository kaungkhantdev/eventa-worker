import {
  bigint,
  customType,
  pgEnum,
  pgTable,
  timestamp,
} from 'drizzle-orm/pg-core';

/** Raw bytes — eventa-api's `_types.ts` `bytea`, which this service has no copy of. */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// MIRROR of eventa-api's `calendar_connections` (E12, US-MTG-08) — only the
// columns the calendar sync reads or writes. eventa-api OWNS the schema and
// migrations (0075); nothing here creates or alters the table.
//
// A WRITE mirror (ADR-15), for exactly one write: `status` → 'expired' (and
// `updated_at`) when Google stops accepting the grant, conditional on the
// cipher this service used. The enum must match eventa-api's EXACTLY.

export const calendarConnectionStatusEnum = pgEnum(
  'calendar_connection_status',
  ['disconnected', 'connected', 'expired'],
);

export const calendarConnections = pgTable('calendar_connections', {
  id: bigint({ mode: 'number' }).primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  status: calendarConnectionStatusEnum().notNull(),
  /**
   * The workspace's Google refresh token, AES-256-GCM under
   * SECRET_ENCRYPTION_KEY (`iv | tag | ciphertext`). Decrypted only into a
   * token request; never logged, never written here.
   */
  refreshTokenCipher: bytea(),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
});

export type CalendarConnectionStatus =
  (typeof calendarConnectionStatusEnum.enumValues)[number];

export const CONNECTED_CALENDAR: CalendarConnectionStatus = 'connected';
export const EXPIRED_CALENDAR: CalendarConnectionStatus = 'expired';
