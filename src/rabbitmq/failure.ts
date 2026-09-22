import { ZodError } from 'zod';

/**
 * Is this failure worth trying again?
 *
 * The worker used to treat every throw alike: one nack, straight to the
 * dead-letter queue, no second attempt. That is right for a payload that will
 * never parse and badly wrong for a thirty-second SMTP outage — and it is how a
 * signup's only verification email was lost to a rotated app password.
 *
 * So the split is by what the error actually says. SMTP and Postgres both
 * report this precisely and neither was ever read: nodemailer carries `code`
 * and `responseCode`, node-postgres carries the SQLSTATE in `code`.
 *
 * The default is to retry. Being wrong about a poison message costs a handful
 * of delayed attempts and it parks anyway; being wrong about a transient one
 * destroys somebody's mail. Only failures known to be hopeless are refused.
 */

/** SMTP `code`s that mean the message itself is unusable. */
const PERMANENT_SMTP_CODES = new Set(['EENVELOPE']);

/**
 * SQLSTATE classes worth another go: 40 is serialization/deadlock, 08 is a
 * connection that failed, 53 is the server out of some resource.
 */
const TRANSIENT_SQLSTATE_CLASSES = ['40', '08', '53'];

interface ErrorFields {
  code?: unknown;
  responseCode?: unknown;
  /** A transport's own verdict; see {@link isRetryable}. */
  retryable?: unknown;
}

function fieldsOf(err: unknown): ErrorFields {
  return typeof err === 'object' && err !== null ? err : {};
}

export function isRetryable(err: unknown): boolean {
  // A body that is not JSON, or does not match the schema, is poison: it will
  // fail identically every time, and retrying only delays the diagnosis.
  if (err instanceof ZodError) return false;
  if (err instanceof SyntaxError) return false;

  const { code, responseCode, retryable } = fieldsOf(err);

  // A transport that already classified its own failure is believed, and read
  // FIRST. An SMS provider speaks HTTP, where 5xx is transient and 4xx is
  // permanent — the exact reverse of SMTP below. Teaching this function both
  // readings would mean guessing which protocol a status came from; saying so
  // on the error removes the guess. See `SmsDeliveryError`.
  if (typeof retryable === 'boolean') return retryable;

  if (typeof code === 'string' && PERMANENT_SMTP_CODES.has(code)) return false;

  // SMTP's own classes: 5xx is permanent, 4xx is "later". Read before `code`,
  // because EAUTH arrives with 535 and a rejected login IS worth retrying — a
  // human fixes the secret, and the ladder bounds the wait either way.
  if (typeof responseCode === 'number' && code !== 'EAUTH') {
    if (responseCode >= 500) return false;
    if (responseCode >= 400) return true;
  }

  if (typeof code === 'string' && isTransientSqlState(code)) return true;

  return true;
}

/** A five-character SQLSTATE whose class is one we expect to pass. */
function isTransientSqlState(code: string): boolean {
  return (
    code.length === 5 && TRANSIENT_SQLSTATE_CLASSES.includes(code.slice(0, 2))
  );
}
