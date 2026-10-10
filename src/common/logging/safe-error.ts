import { dbReason, pgFields } from '../db/db-error';

/**
 * A failure, in terms that are safe to put in a log.
 *
 * WHY NOT `{ err }`. pino's serializer writes an error's message, its stack
 * and every own enumerable property, and three error classes that reach this
 * service's log sites carry personal data in exactly those places:
 *
 * - **Drizzle wraps every query rejection.** Verified against the installed
 *   source (drizzle-orm@0.45.2/errors.cjs:36):
 *   `` super(`Failed query: ${query}\nparams: ${params}`) ``, and it also sets
 *   `this.query` and `this.params`. So the statement and its bound values
 *   appear twice over — and for this service's writes those values are a
 *   buyer's name, email and phone.
 * - **nodemailer names the recipient** in `message`, `response`, `rejected[]`
 *   and `rejectedErrors[].recipient`.
 * - The consumer's dead-letter path logs at ERROR, which production emits.
 *
 * So nothing is spread: this builds a fixed, known set of fields instead.
 */
export interface SafeError {
  /** The error's class, so failure kinds can be counted. */
  name: string;
  /** SQLSTATE, where the failure came from Postgres. */
  code?: string;
  /** What went wrong, with addresses masked and no statement in it. */
  reason: string;
  /** The stack FRAMES — where it happened, which carries nothing personal. */
  at?: string;
}

/**
 * How Drizzle opens the message of every query it wraps — the marker for
 * "the rest of this is a statement and its bound values".
 */
const DRIZZLE_MESSAGE_PREFIX = 'Failed query:';

/** A stack frame line, which is the part of a stack worth keeping. */
const FRAME = /^\s+at\s/;

/**
 * Anything shaped like an email address.
 *
 * Deliberately greedy about what counts: a false positive costs one masked
 * word in a log line, a false negative is somebody's address in it. Honest
 * about the limit — this masks ADDRESSES, not names. A transport that echoed
 * "Somchai Jaidee <...>" would still print the display name, which is why the
 * query path above drops its message outright rather than masking it.
 */
const EMAIL = /[^\s<>,;:"']+@[^\s<>,;:"']+/g;
const MASKED = '[address]';

export function safeError(cause: unknown): SafeError {
  if (!(cause instanceof Error)) {
    return { name: 'unknown', reason: mask(String(cause)) };
  }
  const at = frames(cause);
  if (cause.message.startsWith(DRIZZLE_MESSAGE_PREFIX)) {
    // The message is the statement and its parameters. There is nothing in it
    // worth keeping, so it is replaced rather than masked.
    return {
      name: cause.name,
      code: sqlstate(cause),
      reason: dbReason(cause),
      at,
    };
  }
  return {
    name: cause.name,
    code: sqlstate(cause),
    reason: mask(cause.message),
    at,
  };
}

/** The bare SQLSTATE; the constraint rides along in `reason` instead. */
function sqlstate(cause: Error): string | undefined {
  return pgFields(cause)?.code;
}

function frames(cause: Error): string | undefined {
  const lines = (cause.stack ?? '').split('\n').filter((l) => FRAME.test(l));
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function mask(text: string): string {
  return text.replace(EMAIL, MASKED);
}
