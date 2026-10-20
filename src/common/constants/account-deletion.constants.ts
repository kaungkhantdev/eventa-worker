/** The account-deletion module's named constants. */

/** Account mail has no event behind it, so it is dated in Thailand. */
export const NOTICE_TIMEZONE = 'Asia/Bangkok';

/** Routing key for the account-closure notice, emitted by eventa-api's outbox. */
export const IDENTITY_ACCOUNT_DELETION_REQUESTED =
  'identity.account_deletion_requested';
