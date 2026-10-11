/**
 * A pre-send database read that may only REFINE a message, never decide it.
 *
 * THE DISTINCTION THIS FILE ENCODES. A handler's lookup before a send supplies
 * either something ESSENTIAL — who to mail, whether to mail at all — or a mere
 * REFINEMENT: which language to write in. An essential lookup that fails must
 * leave the work owed, so the message retries. A refinement that fails must
 * change nothing at all, because the message is already correct and already
 * addressed without it.
 *
 * Getting that backwards is how a language lookup came to suppress two security
 * alerts. `TwoFactorDisabledHandler` and `AccountDeletionRequestedHandler`
 * carry the recipient address and every word of the copy on the event; the read
 * adds a `Locale` and nothing else. While the handlers classified the failure
 * and rethrew the ones they could not place, a refused connection nacked the
 * message, burned the retry ladder and parked it in the dead-letter queue — and
 * the person whose second factor had just been removed, or whose account had
 * just been closed, was told nothing whatsoever.
 *
 * SO THERE IS NOTHING TO CLASSIFY HERE. The instinct that a SQLSTATE class 42
 * deserves to be loud is right in general and wrong here, because the
 * alternative to loudness is not a mis-sent message — it is NO message about a
 * possible account compromise. An English alert that arrives beats a
 * perfectly-localised one that does not exist. This resolves with the fallback
 * for ANY failure: a classified outage, an unclassifiable one, a `TypeError`, a
 * thrown string. Loudness belongs in the `onDegraded` warn line and its
 * counter, which is why reporting is a parameter rather than optional.
 *
 * It is a function with a test rather than a `catch` in each handler so that
 * "this read cannot stop the send" is stated once, proved once, and cannot be
 * narrowed back to a guard by a later edit to one of them.
 *
 * THERE WAS A SHARED SQLSTATE GUARD HERE — `transient-sql-state.ts`, deleted
 * once the last caller stopped asking it anything. It returned the SQLSTATE of
 * a failure a caller could degrade past and null for one it could not, and
 * every reader should know why it is gone and not worth rebuilding:
 *
 * - It could not recognise an outage. A refused connection never reaches a
 *   server, so no SQLSTATE comes back: node-postgres hands up the socket's
 *   errno (`ECONNREFUSED`) on the same `code` field, and pg's own pool timeout
 *   (`new Error('timeout expired')`) carries no code at all. A guard asking for
 *   a five-character SQLSTATE therefore fired only while the database was up
 *   and answering — the exact opposite of its purpose. Length is not even a
 *   discriminator between the two: `EPIPE` is five characters.
 * - Nothing on a codeless throw distinguishes a pool timeout from a
 *   `TypeError`, so a correct classifier is not available at all without
 *   matching another library's wording.
 * - And the classification had nothing left to decide. This service's three
 *   pre-send identity lookups split cleanly in two: the refinements degrade
 *   whatever happened (here), and the one ESSENTIAL read —
 *   `UsersRepository.currentAddress`, where a failure leaves no address to warn
 *   and a warning has no degraded form — leaves the message owed so it retries,
 *   also whatever happened. Neither side asks which failure it was.
 *
 * `rabbitmq/failure.ts` still reads SQLSTATE classes, and correctly: it decides
 * whether to RETRY and defaults to true for anything it does not recognise, so
 * a code it has never heard of is retried rather than refused.
 */

/**
 * Read `refinement`, or fall back.
 *
 * Never rejects for a failure of `read` — synchronous throw included.
 * `onDegraded` receives the failure's own code (a SQLSTATE, a socket errno) or
 * null when it carries none, so the caller can log and count the degradation
 * without logging the error itself: a node-postgres error can carry more than
 * the ids that were bound, and these handlers mail people about their own
 * accounts. `onDegraded` must not throw; nothing in the degradation path may
 * cost the reader the message.
 */
export async function readRefinement<T>(
  read: () => Promise<T>,
  fallback: T,
  onDegraded: (code: string | null) => void,
  timeoutMs: number = REFINEMENT_DEADLINE_MS,
): Promise<T> {
  try {
    return await Promise.race([read(), deadline<T>(timeoutMs)]);
  } catch (cause) {
    report(onDegraded, codeOf(cause));
    return fallback;
  }
}

/**
 * How long a refinement may take before the message goes without it.
 *
 * A rejection is not the only way this read can cost the reader their message:
 * a saturated pool, a lock held on `users`, or a TCP blackhole after a failover
 * yields a promise that never settles, and NOTHING else bounds it. The Pool in
 * `db/database.module.ts` is built with no `connectionTimeoutMillis` — pg-pool
 * reads the default 0 as "wait forever for a client" — no `statement_timeout`
 * and no `query_timeout`, and it shares its ten connections with the
 * registration handler and the order-expiry sweep. `ConsumerService.onMessage`
 * puts no deadline on a handler either. So an unbounded await here withheld the
 * alert for as long as the database stayed unwell, which is strictly worse than
 * the handler that preceded all of this and touched no database at all.
 *
 * Short on purpose. This buys a language, and the reader is waiting for a
 * security alert; a second of Thai is not worth a second of delay, let alone
 * the indefinite one. Bounding it HERE rather than only on the Pool keeps the
 * guarantee in the file that states it — a Pool setting is a deployment
 * concern that a later environment can quietly drop.
 */
const REFINEMENT_DEADLINE_MS = 1_000;

/** Rejects once the deadline passes, so `Promise.race` takes the fallback. */
function deadline<T>(ms: number): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    // `unref` so a pending timer cannot hold the process open at shutdown; the
    // race is normally won by the read, leaving this timer to expire unheeded.
    setTimeout(
      () => reject(new Error('refinement read timed out')),
      ms,
    ).unref();
  });
}

/**
 * Report the degradation, and never let reporting become the failure.
 *
 * The docstring above asks `onDegraded` not to throw, and asking is not
 * enforcing. The one path whose entire purpose is to be loud about a problem
 * must not be the path that turns that problem into a lost message — a counter
 * whose backend is down during the outage being counted is not far-fetched.
 */
function report(
  onDegraded: (code: string | null) => void,
  code: string | null,
): void {
  try {
    onDegraded(code);
  } catch {
    // Deliberately swallowed and deliberately not logged: the logger is a
    // plausible reason we are here, and the message still has to go out.
  }
}

/** The error's own `code`, or null — all a warn line is allowed to carry. */
function codeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : null;
}
