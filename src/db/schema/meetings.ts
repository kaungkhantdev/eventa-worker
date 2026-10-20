import {
  bigint,
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `meetings` (E12) — only the columns the calendar sync
// reads or writes (US-MTG-04..08). eventa-api OWNS the schema and migrations
// (0045); nothing here creates or alters the table.
//
// This is a WRITE mirror (ADR-15): the sync writes `sync_status`, `sync_error`
// and `link` — conditional on `updated_at` — and `external_event_id`. So the
// pgEnum names and values below must match eventa-api's EXACTLY; a value
// missing here fails a write instead of being quietly absent from a read.
// When eventa-api changes one of these enums, change it here in the same breath.

export const meetingModeEnum = pgEnum('meeting_mode', [
  'Video',
  'In person',
  'Phone',
]);

export const meetingStatusEnum = pgEnum('meeting_status', [
  'scheduled',
  'cancelled',
]);

/**
 * eventa-api writes `pending` on every write; this service writes the other
 * three — never `pending`.
 */
export const meetingSyncStatusEnum = pgEnum('meeting_sync_status', [
  'pending',
  'synced',
  'failed',
  'not_connected',
]);

export const meetings = pgTable('meetings', {
  id: uuid().primaryKey(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  title: text().notNull(),
  /** Bangkok calendar day, 'YYYY-MM-DD'. */
  meetingDate: date({ mode: 'string' }).notNull(),
  /** Bangkok wall clock, 'HH:MM:SS'. */
  startTime: time().notNull(),
  endTime: time().notNull(),
  mode: meetingModeEnum().notNull(),
  status: meetingStatusEnum().notNull(),
  syncStatus: meetingSyncStatusEnum().notNull(),
  person: text().notNull(),
  /** citext in eventa-api; read as text here, which is all the sync needs. */
  guestEmail: text().notNull(),
  location: text(),
  notes: text(),
  link: text(),
  cancellationReason: text(),
  externalEventId: text(),
  syncError: text(),
  /** Read for the Meet conference request id; NEVER written here. */
  version: integer().notNull(),
  deletedAt: timestamp({ withTimezone: true }),
  /**
   * The change token the sync's writes are conditional on. STRING mode is
   * required: the value is compared EXACTLY, and a JS Date would drop the
   * microseconds Postgres keeps, so the comparison would never match.
   *
   * No default and no `$onUpdate`: this service NEVER writes `updated_at` (or
   * `version`) — eventa-api sets it on every write, and that is what makes a
   * newer organizer change supersede an older sync.
   */
  updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
});

export type MeetingMode = (typeof meetingModeEnum.enumValues)[number];
export type MeetingSyncStatus =
  (typeof meetingSyncStatusEnum.enumValues)[number];

/** The values this service compares against, named once. */
export const VIDEO_MEETING: MeetingMode = 'Video';
export const CANCELLED_MEETING = 'cancelled';
export const SYNCED_MEETING: MeetingSyncStatus = 'synced';
