/**
 * The `sync_error` for a connection this worker cannot decrypt — what a
 * SECRET_ENCRYPTION_KEY that is not eventa-api's looks like from a card.
 * Fixed, like the calendar's own sentences: it is shown to the organizer.
 */
export const UNREADABLE_CONNECTION_SENTENCE =
  'The Google Calendar connection could not be read.';

/** Why a sync is put off rather than failed. */
export type MeetingSyncRetryReason =
  /** Another delivery for the same meeting holds the lock right now. */
  | 'busy'
  /** Google accepted the Meet request and has not minted the link yet. */
  | 'link_pending';

/**
 * Not now — try again. The meeting is untouched (still `pending`), and the
 * consumer's retry ladder brings the message back (5s, 30s, 2m, 10m).
 *
 * `retryable` is a FIELD set in the constructor because `rabbitmq/failure.ts`
 * reads a boolean `retryable` before anything else.
 */
export class MeetingSyncRetry extends Error {
  readonly retryable: boolean;

  constructor(readonly reason: MeetingSyncRetryReason) {
    super(`Meeting sync put off (${reason})`);
    this.name = 'MeetingSyncRetry';
    this.retryable = true;
  }
}

/**
 * A sync that no retry can fix, so the message parks in the dead-letter queue
 * where an operator will see it. The meeting row already says `failed`.
 */
export class MeetingSyncFailure extends Error {
  readonly retryable: boolean;

  constructor(message: string) {
    super(message);
    this.name = 'MeetingSyncFailure';
    this.retryable = false;
  }
}
