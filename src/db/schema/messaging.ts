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

/** How one message left: the delivery log's channel, and the catalog's. */
export type MessageChannel = (typeof messageChannelEnum.enumValues)[number];

/**
 * Catalog slugs this service sends for. eventa-api owns the catalog and is the
 * one that decides a message is switchable — a slug belongs here only once a
 * handler both sends it AND checks `active`, or the switch in the UI would move
 * and change nothing.
 */
export const REGISTRATION_CONFIRMATION_SLUG = 'registration-confirmation';
/**
 * The other half of an organizer's decision (US-REG-02): the sign-up they
 * turned down. On until a workspace switches it off, like the confirmation —
 * so it is deliberately NOT in {@link OFF_UNTIL_SWITCHED_ON_SLUGS}, which
 * matches `defaultActive: true` on the API catalog's `rejection-notice`.
 */
export const REJECTION_NOTICE_SLUG = 'rejection-notice';
export const CANCELLATION_NOTICE_SLUG = 'cancellation-notice';
/** The itemized VAT receipt for a paid registration (US-SET-10). */
export const PAYMENT_RECEIPT_SLUG = 'payment-receipt';
/**
 * A seat offered to someone on the waitlist (US-REG-04). Its switch also
 * governs the notice that an offer lapsed — somebody never told of an offer
 * should not be told it expired — which logs under its own kind below.
 */
export const WAITLIST_OFFER_SLUG = 'waitlist-offer';
export const WAITLIST_OFFER_EXPIRED_KIND = 'waitlist-offer-expired';

/**
 * The invitation an organizer sends to a named person (US-REG-06). Unlike the
 * messages above, nobody is ENTITLED to it — the API catalog marks it
 * `expected: false` — so switching it off needs no warning. It is still the
 * organizer's to switch off, which is why it is here: it is attendee-facing
 * mail the workspace sends, not identity mail somebody is owed.
 */
export const EVENT_INVITATION_SLUG = 'event-invitation';

/**
 * Kinds that appear in the delivery log but are not catalog templates: a
 * one-off broadcast an organizer wrote, and the notice that goes out when a
 * payment has to be given back. Neither has a switch, because neither is an
 * automated message an organizer configures.
 */
export const ANNOUNCEMENT_KIND = 'announcement';

/** Sent the day after an event with a live survey (US-MSG-08). */
export const POST_EVENT_THANKYOU_SLUG = 'post-event-thankyou';
/** Sent a day before an event starts, to cut no-shows (US-MSG-01). */
export const EVENT_REMINDER_SLUG = 'event-reminder';
export const REFUND_NOTICE_KIND = 'refund-notice';

/**
 * A session somebody has on their schedule moved — a new day, time or room
 * (US-PROG-03). Sent only when the organizer chooses to announce the change;
 * a REMOVED session deliberately tells nobody (US-PROG-04), so there is no
 * second slug for that.
 */
export const SESSION_CHANGE_SLUG = 'session-change';

/**
 * Messages that are OFF in a workspace until its organizer switches them on —
 * what an ABSENT `message_templates` row means for these slugs. Every other
 * slug is on until switched off.
 *
 * MIRRORS the `defaultActive: false` entries of eventa-api's
 * src/modules/message-templates/message-template-catalog.ts. The API decides
 * what the organizer SEES and this decides what is SENT: if they disagree, the
 * page says "Inactive" while attendees are mailed, or "Active" while nobody
 * is. Change both together; each side's spec pins the list.
 *
 * Declared after the slug it lists, or module load would hit it uninitialised.
 */
export const OFF_UNTIL_SWITCHED_ON_SLUGS: readonly string[] = [
  EVENT_REMINDER_SLUG,
];

export const messageTemplates = pgTable('message_templates', {
  id: bigint({ mode: 'number' }).primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  slug: text().notNull(),
  /**
   * The organizer's kill switch. An ABSENT row means the slug's default: on,
   * except for {@link OFF_UNTIL_SWITCHED_ON_SLUGS}.
   */
  active: boolean().notNull(),
  /**
   * Which channels this workspace's copy of the message goes out on. READ, not
   * just mirrored: the confirmation is texted only when 'sms' is in here
   * (US-DISC-06). An ABSENT row means the API catalog's own channels, which
   * for the registration confirmation is email AND sms.
   */
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

/**
 * MIRROR of eventa-api's `surveys` — only what the thank-you job needs: whether
 * an event has a LIVE survey to link to. eventa-api owns it.
 */
export const surveys = pgTable('surveys', {
  id: bigint({ mode: 'number' }).primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  eventId: uuid().notNull(),
  status: text().notNull(),
});

/**
 * MIRROR of eventa-api's `event_message_runs` — bookkeeping for the messages
 * this service sends on a schedule. This service WRITES it: the claim stops a
 * second run emailing everybody twice, and `completedAt` lets a crashed run be
 * resumed instead of treated as done.
 */
export const eventMessageRuns = pgTable('event_message_runs', {
  id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  eventId: uuid().notNull(),
  kind: text().notNull(),
  requestedAt: timestamp({ withTimezone: true }).notNull(),
  completedAt: timestamp({ withTimezone: true }),
});
