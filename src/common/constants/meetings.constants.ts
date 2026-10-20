/** The meetings module's named constants. */

/** How one delivery ended — logged, never shown to anybody. */
export const OUTCOME = {
  /** The meeting no longer exists, or was deleted. Nothing to do. */
  gone: 'gone',
  /** A redelivery, or a message a newer one already settled. */
  already_synced: 'already_synced',
  not_connected: 'not_connected',
  /** Google refused the grant; the connection is now marked expired. */
  connection_expired: 'connection_expired',
  synced: 'synced',
  /** The organizer changed the meeting mid-sync; the newer message owns it. */
  superseded: 'superseded',
  failed: 'failed',
  /** Google has not minted the Meet link yet; the message comes back. */
  link_pending: 'link_pending',
} as const;

/** Seconds are not part of a meeting time; the calendar gets ':00'. */
export const HH_MM = 5;

/** Routing key eventa-api's `meeting-sync.event.ts` writes to the outbox. */
export const MEETING_SYNC_REQUESTED = 'meeting.sync_requested';

/**
 * The `sync_error` for a connection this worker cannot decrypt — what a
 * SECRET_ENCRYPTION_KEY that is not eventa-api's looks like from a card.
 * Fixed, like the calendar's own sentences: it is shown to the organizer.
 */
export const UNREADABLE_CONNECTION_SENTENCE =
  'The Google Calendar connection could not be read.';

export const KEY_PREFIX = 'lock:meeting-sync:';

/**
 * Longer than any one sync can take — a token request, an upsert with one
 * fallback, each capped at ten seconds — and short enough that a worker that
 * died holding it delays the next attempt by a minute at most.
 */
export const LOCK_TTL_MS = 60_000;

/** Delete the key only if it still holds OUR token, atomically. */
export const RELEASE_SCRIPT =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
