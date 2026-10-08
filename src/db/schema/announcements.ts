import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `announcements` — only the columns the scheduled
// announcement sweep reads or writes (US-MSG-04/05). eventa-api OWNS the schema
// and its migrations (0054, 0065); nothing here creates or alters the table.
//
// This service WRITES it: the sweep moves a due announcement from `scheduled`
// to `sent` (or, when its event is gone, to `cancelled`). The table's
// `ck_announcements_state` CHECK is what catches a write that leaves a status
// and its columns disagreeing, so drift here fails loudly rather than quietly.
export const announcements = pgTable('announcements', {
  id: bigint({ mode: 'number' }).primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  eventId: uuid().notNull(),
  subject: text().notNull(),
  body: text().notNull(),
  sentByUserId: uuid(),
  /**
   * Read as text, like `events.status`: the sweep writes three literals and
   * mirroring the enum would be one more list to keep in step with eventa-api.
   */
  status: text().notNull(),
  scheduledFor: timestamp({ withTimezone: true }),
  sentAt: timestamp({ withTimezone: true }),
  recipientCount: bigint({ mode: 'number' }),
  cancelledAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
});

/** eventa-api's `announcement_status` values, as this service writes them. */
export const SCHEDULED_ANNOUNCEMENT = 'scheduled';
export const SENT_ANNOUNCEMENT = 'sent';
export const CANCELLED_ANNOUNCEMENT = 'cancelled';
