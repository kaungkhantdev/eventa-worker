import {
  bigint,
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `events`, `organizations` and `users` — only the read
// columns the confirmation email needs. eventa-api OWNS the schema.
export const localeEnum = pgEnum('locale', ['en', 'th']);
export const userPersonaEnum = pgEnum('user_persona', ['admin', 'attendee']);

/**
 * Every attendee account lives in this one workspace, so a person's tickets can
 * span organizers. Mirrors eventa-api's `common/tenancy/platform-org.ts`.
 */
export const PLATFORM_ORG_SLUG = 'eventa';
export const ATTENDEE_PERSONA = 'attendee' as const;

export type Locale = (typeof localeEnum.enumValues)[number];

export const events = pgTable('events', {
  id: uuid().primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  name: text().notNull(),
  slug: text().notNull(),
  startAt: timestamp({ withTimezone: true }).notNull(),
  endAt: timestamp({ withTimezone: true }),
  timezone: text().notNull(),
  venueName: text(),
  venueAddress: text(),
  city: text(),
  isOnline: boolean().notNull(),
  /** Where an online event actually happens; the only join-link field. */
  onlineNote: text(),
  organizerName: text().notNull(),
  contactEmail: text(),
  /** The language this event's messages default to; null → the org's. */
  locale: localeEnum(),
  /**
   * Read as text: this service only ever asks whether an event was CANCELLED
   * (nobody should be thanked for attending one), and mirroring the whole enum
   * would be one more list to keep in step with eventa-api.
   */
  status: text().notNull(),
  deletedAt: timestamp({ withTimezone: true }),
});

/** The one event status this service acts on. */
export const CANCELLED_EVENT_STATUS = 'cancelled';

export const organizations = pgTable('organizations', {
  id: bigint({ mode: 'number' }).primaryKey(),
  name: text().notNull(),
  slug: text().notNull(),
  locale: localeEnum().notNull(),
});

export const users = pgTable('users', {
  id: uuid().primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  email: text().notNull(), // citext in eventa-api; read as text here
  persona: userPersonaEnum().notNull(),
  /** A registered attendee's own choice; null → the event's, then the org's. */
  locale: localeEnum(),
  deletedAt: timestamp({ withTimezone: true }),
});
