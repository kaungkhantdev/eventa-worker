/** The auth-booking-signup module's named constants. */

/** Account mail has no event timezone behind its deadline; it is Thailand's. */
export const NOTICE_TIMEZONE = 'Asia/Bangkok';

/**
 * Routing key for the link that claims an account from a booking (US-DISC-15),
 * emitted by eventa-api's outbox when a guest asks to keep their tickets.
 */
export const IDENTITY_BOOKING_ACCOUNT_LINK_REQUESTED =
  'identity.booking_account_link_requested';
