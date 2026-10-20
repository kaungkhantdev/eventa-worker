/** The event-program module's named constants. */

/** ` → ` — the before and the after, in the order they happened. */
export const TO = ' → ';

/**
 * Routing key for a session that moved on a schedule people are following
 * (US-PROG-03). Mirrors eventa-api's `SESSION_CHANGED`.
 */
export const PROGRAM_SESSION_CHANGED = 'program.session_changed';

/** `9:05` or `09:05:00` — the hour may arrive unpadded, the seconds absent. */
export const HOUR_MINUTE_SECOND = /^\d{1,2}:\d{2}(:\d{2})?$/;

/** `2026-10-12`. */
export const DATE_KEY_LENGTH = 10;

export const HOUR_MINUTE_LENGTH = 5;

/**
 * Rendering timezone, not the event's: the wall clock is already the event's
 * local time, so pinning the formatter to UTC passes it through unshifted.
 */
export const UTC = 'UTC';

/** An en dash between the two times, as a range takes rather than a hyphen. */
export const EN_DASH = '–';
