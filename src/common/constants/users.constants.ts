import type { Locale } from '../../db/schema/events';

/** The users module's named constants. */

/**
 * The two messages one email change owes, each recorded in the ledger once it
 * is away. Named constants because they are ledger KEYS: renaming one makes
 * every message in flight owe that part again.
 */
export const CONFIRMATION_PART = 'confirmation';

export const HEADS_UP_PART = 'heads-up';

/**
 * Security alerts are stamped in Thailand's time, whatever the reader's own
 * clock says — the same rule receipts and the two-factor alert follow. The
 * timestamp crosses the bus in UTC; this is the only place it becomes a wall
 * clock.
 */
export const NOTICE_TIMEZONE = 'Asia/Bangkok';

/** BCP-47 tag per locale; `th-TH` also gives a Thai reader the Buddhist era. */
export const BCP47: Record<Locale, string> = { en: 'en-GB', th: 'th-TH' };

/**
 * How long the confirmation link lives, as a number so each language can
 * phrase it.
 *
 * Named rather than inlined because it is duplicated knowledge: the lifetime is
 * the producer's `EMAIL_CHANGE_TTL_SECONDS` (24 hours) and it is not carried on
 * the payload, so if eventa-api ever shortens it this is the one place that
 * silently starts lying and the one place to correct.
 */
export const LINK_LIFETIME_HOURS = 24;

/**
 * The greeting when no name is printed: the heads-up never prints one, and the
 * confirmation falls back to it rather than greeting `Hi ,` when
 * `safeDisplayName` finds nothing usable in a name. No politeness particle, the
 * same as every other Thai greeting in this service.
 */
export const NAMELESS_GREETING: Record<Locale, string> = {
  en: 'Hello,',
  th: 'สวัสดี',
};

/** Routing key for the "confirm your new email" message, emitted by eventa-api. */
export const IDENTITY_EMAIL_CHANGE_REQUESTED =
  'identity.email_change_requested';

/** Routing key for the "here is your confirmation code" text, emitted by eventa-api. */
export const IDENTITY_PHONE_VERIFICATION_REQUESTED =
  'identity.phone_verification_requested';
