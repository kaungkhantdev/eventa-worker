/** The auth-signup module's named constants. */

export const SUBJECT = 'Confirm your email to finish signing up';

/** Routing key for the sign-up confirmation email, emitted by eventa-api's outbox. */
export const IDENTITY_EMAIL_VERIFICATION_REQUESTED =
  'identity.email_verification_requested';
