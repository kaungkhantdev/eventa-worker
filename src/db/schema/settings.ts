import { bigint, boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `notification_preferences` — only the read columns
// a scheduled message needs to honour a person's own switch. eventa-api OWNS
// the schema and migrations; nothing here writes it.

/**
 * The attendee's "Event reminders" switch in the portal's Settings tab
 * (US-DISC-12) — one value of eventa-api's `notification_kind` enum. The only
 * category a message sent from here honours today.
 */
export const REMINDER_PREFERENCE = 'reminder';

export type NotificationCategory = typeof REMINDER_PREFERENCE;

export const notificationPreferences = pgTable('notification_preferences', {
  organizationId: bigint({ mode: 'number' }).notNull(),
  userId: uuid().notNull(),
  /**
   * `notification_kind` in eventa-api, read as text: this service only ever
   * asks for one category by name, and mirroring the whole enum would be one
   * more list to keep in step.
   */
  category: text().notNull(),
  /** An ABSENT row means on — the default eventa-api reports. */
  emailEnabled: boolean().notNull(),
});
