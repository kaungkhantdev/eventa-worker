import type { Locale } from '../../db/schema/events';

/** The auth-two-factor module's named constants. */

/**
 * Security alerts are stamped in Thailand's time, whatever the reader's own
 * clock says — the same rule receipts follow. The timestamp crosses the bus in
 * UTC; this is the only place it becomes a wall clock.
 */
export const NOTICE_TIMEZONE = 'Asia/Bangkok';

/** BCP-47 tag per locale; `th-TH` also gives a Thai reader the Buddhist era. */
export const BCP47: Record<Locale, string> = { en: 'en-GB', th: 'th-TH' };

/** Routing key for the "two-factor turned off" notice from eventa-api. */
export const IDENTITY_TWO_FACTOR_DISABLED = 'identity.two_factor_disabled';
