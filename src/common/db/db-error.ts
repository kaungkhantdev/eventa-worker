/** How deep to follow `cause` before giving up. Wrappers nest, but not far. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Why the database refused, in terms that are safe to put in a log.
 *
 * NOT the error's message. Drizzle wraps every query failure, and it builds
 * the wrapper like this (drizzle-orm@0.45.2/errors.cjs:36):
 *
 *     constructor(query, params, cause) {
 *       super(`Failed query: ${query}\nparams: ${params}`);
 *
 * so the message carries THE BOUND PARAMETERS. For the writes this service
 * makes, those parameters are people: a `message_deliveries` insert binds the
 * recipient's email address and their name — the same name `fill()`
 * substitutes for `{{first_name}}`. Logging `cause.message` therefore printed
 * somebody's contact details at `warn`, which is emitted in production.
 *
 * Shared rather than written per call site because it has already been got
 * wrong three times in two repos: eventa-api's `isUniqueViolation` read the
 * wrapper instead of the pg error beneath it, and the email and SMS delivery
 * recorders each carried their own `reasonOf` that returned the message whole.
 *
 * SQLSTATE and the constraint name are what an operator acts on, and neither
 * can carry personal data: one comes from Postgres's own table, the other from
 * a migration in this repo.
 */
export function dbReason(cause: unknown): string {
  const pg = pgFields(cause);
  if (pg) {
    return pg.constraint ? `${pg.code} (${pg.constraint})` : pg.code;
  }
  // Nothing identifiable: name the TYPE, never the message it carries.
  return cause instanceof Error ? cause.name : 'unknown';
}

/**
 * The node-postgres error inside whatever threw, or null.
 *
 * The chain is walked rather than the wrapper special-cased: it costs nothing,
 * it keeps working if drizzle stops wrapping or starts wrapping twice, and a
 * raw query that never passed through drizzle still works. The field is
 * `constraint`, not `constraint_name` — `pg-protocol` builds the error with
 * `message.constraint = fields.n`, and asking for the other name is how the
 * API's own guard managed to be silently always false.
 */
export function pgFields(
  cause: unknown,
): { code: string; constraint?: string } | null {
  let current: unknown = cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (typeof code === 'string') {
      return typeof constraint === 'string' ? { code, constraint } : { code };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
