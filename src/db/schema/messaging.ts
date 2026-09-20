import {
  bigint,
  boolean,
  pgEnum,
  pgTable,
  text,
  uuid,
  timestamp,
} from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `message_templates` — the read columns this service
// needs to decide whether an automated message may be sent. eventa-api OWNS the
// schema and migrations; keep in sync with entities.md.
export const messageChannelEnum = pgEnum('message_channel', ['email', 'sms']);

/**
 * Catalog slugs this service sends for. eventa-api owns the catalog and is the
 * one that decides a message is switchable — a slug belongs here only once a
 * handler both sends it AND checks `active`, or the switch in the UI would move
 * and change nothing.
 */
export const REGISTRATION_CONFIRMATION_SLUG = 'registration-confirmation';
export const CANCELLATION_NOTICE_SLUG = 'cancellation-notice';

/**
 * Kinds that appear in the delivery log but are not catalog templates: a
 * one-off broadcast an organizer wrote, and the notice that goes out when a
 * payment has to be given back. Neither has a switch, because neither is an
 * automated message an organizer configures.
 */
export const ANNOUNCEMENT_KIND = 'announcement';
export const REFUND_NOTICE_KIND = 'refund-notice';

export const messageTemplates = pgTable('message_templates', {
  id: bigint({ mode: 'number' }).primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  slug: text().notNull(),
  /** The organizer's kill switch. An ABSENT row means active. */
  active: boolean().notNull(),
  channels: messageChannelEnum().array().notNull(),
  /**
   * The organizer's own wording (US-MSG-02). NULL means "use the built-in
   * copy" — never "send a blank", which is why eventa-api stores an emptied
   * field as null rather than as an empty string.
   */
  emailSubjectEn: text(),
  emailSubjectTh: text(),
  emailBodyEn: text(),
  emailBodyTh: text(),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
});

/** What became of one message. Only what the transport could actually say. */
export const deliveryStatusEnum = pgEnum('delivery_status', ['sent', 'failed']);

/**
 * MIRROR of eventa-api's `message_deliveries` — the delivery log (US-MSG-06).
 * This service WRITES it as it sends; eventa-api owns the schema and reads it
 * back for the organizer. One row per recipient.
 */
export const messageDeliveries = pgTable('message_deliveries', {
  // GENERATED ALWAYS in the real table, so Drizzle must leave it off inserts.
  id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  eventId: uuid(),
  kind: text().notNull(),
  channel: messageChannelEnum().notNull().default('email'),
  recipientEmail: text().notNull(),
  recipientName: text(),
  status: deliveryStatusEnum().notNull(),
  error: text(),
  sentAt: timestamp({ withTimezone: true }).notNull(),
});
