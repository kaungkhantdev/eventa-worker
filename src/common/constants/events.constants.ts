/** The events module's named constants. */

/** Routing key for an organizer's "Email all attendees" broadcast (US-EVT-14). */
export const EVENTS_ATTENDEES_EMAIL_REQUESTED =
  'events.attendees_email_requested';

/** Routing key for a cancellation, emitted by eventa-api's outbox (US-EVT-08). */
export const EVENTS_CANCELLED = 'events.cancelled';

/** Routing key for the "event published" notice, emitted by eventa-api's outbox. */
export const EVENTS_PUBLISHED = 'events.published';

/** Pending, with its decision asked for, is waiting on the organizer. */
export const PENDING_ORDER_STATUS = 'pending';
