import type { Locale } from '../../db/schema/events';

/** The auth-password module's named constants. */

/**
 * Security notices are stamped in Thailand's time, whatever the reader's own
 * clock says — the same rule receipts and the two-factor alert follow. The
 * timestamp crosses the bus in UTC; this is the only place it becomes a wall
 * clock.
 */
export const NOTICE_TIMEZONE = 'Asia/Bangkok';

/** BCP-47 tag per locale; `th-TH` also gives a Thai reader the Buddhist era. */
export const BCP47: Record<Locale, string> = { en: 'en-GB', th: 'th-TH' };

/** Routing key for the "your password was changed" notice from eventa-api. */
export const IDENTITY_PASSWORD_CHANGED = 'identity.password_changed';

export const SUBJECT = 'Reset your Eventa password';

/** Routing key for the password-reset email, emitted by eventa-api's outbox. */
export const IDENTITY_PASSWORD_RESET_REQUESTED =
  'identity.password_reset_requested';
