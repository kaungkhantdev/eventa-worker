import {
  bigint,
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `message_templates` — the read columns this service
// needs to decide whether an automated message may be sent. eventa-api OWNS the
// schema and migrations; keep in sync with entities.md.
export const messageChannelEnum = pgEnum('message_channel', ['email', 'sms']);

/** The slug of the message this service sends on `registration.confirmed`. */
export const REGISTRATION_CONFIRMATION_SLUG = 'registration-confirmation';

export const messageTemplates = pgTable('message_templates', {
  id: bigint({ mode: 'number' }).primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  slug: text().notNull(),
  /** The organizer's kill switch. An ABSENT row means active. */
  active: boolean().notNull(),
  channels: messageChannelEnum().array().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
});
