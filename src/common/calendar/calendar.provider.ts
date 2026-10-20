/**
 * One meeting, as the calendar needs it (US-MTG-04/05/07).
 *
 * Built from the CURRENT meetings row, never from the message: the row is the
 * source of truth, and a message can be stale by the time it is consumed.
 */
export interface CalendarEventInput {
  /** `googleEventIdOf(meeting.id)` — deterministic, so every attempt names the same event. */
  eventId: string;
  summary: string;
  description: string;
  location: string | null;
  /** 'YYYY-MM-DDTHH:MM:00', Bangkok wall clock — sent with `timeZone: 'Asia/Bangkok'`. */
  startLocal: string;
  endLocal: string;
  guestEmail: string;
  guestName: string;
  /**
   * What to do about the Meet link: mint one (`create`), leave the one the
   * event already has (`keep`), or take it away because the meeting is no
   * longer a video call (`remove`).
   */
  meet: 'create' | 'keep' | 'remove';
  /**
   * Google dedupes conference creation on this, so a retried attempt for the
   * same meeting version gets the same Meet link rather than a second one.
   */
  conferenceRequestId: string;
}

export interface CalendarEventResult {
  eventId: string;
  meetLink: string | null;
  /** Google accepted the Meet request but has not minted the link yet. */
  meetPending: boolean;
}

/**
 * Why a calendar call failed, in the three kinds a caller can act on:
 *
 * - `auth_revoked` — the workspace's grant is gone (revoked, expired, scope
 *   removed). Only an Admin reconnecting fixes it; retrying cannot.
 * - `unavailable` — Google is down, slow or rate-limiting. Worth retrying.
 * - `rejected` — Google refused this request and will refuse it again.
 */
export type CalendarFailure = 'auth_revoked' | 'unavailable' | 'rejected';

/** The fixed sentences — also the `meetings.sync_error` values (§5.6). */
export const CALENDAR_UNAVAILABLE_SENTENCE =
  'Google Calendar is unavailable right now.';
export const CALENDAR_EXPIRED_SENTENCE =
  'The Google Calendar connection has expired.';
const rejectedSentence = (status: number | null): string =>
  status === null
    ? 'Google Calendar refused the request.'
    : `Google Calendar refused the request (HTTP ${status}).`;

const SENTENCES: Record<CalendarFailure, (status: number | null) => string> = {
  unavailable: () => CALENDAR_UNAVAILABLE_SENTENCE,
  auth_revoked: () => CALENDAR_EXPIRED_SENTENCE,
  rejected: rejectedSentence,
};

/**
 * A calendar call that did not succeed, and whether another attempt can help.
 *
 * `retryable` is a FIELD set here, because `rabbitmq/failure.ts` reads a
 * boolean `retryable` before anything else — the same arrangement as
 * `SmsDeliveryError`, and for the same reason: an HTTP status must never reach
 * the `code`/`responseCode` fields that file reads with SMTP meanings.
 *
 * The message is one of three FIXED sentences and is written verbatim into
 * `meetings.sync_error`, which the organizer sees. So it never carries a vendor
 * body, a reason string, an address, a title or a token — only, for a refusal,
 * the HTTP status.
 */
export class CalendarSyncError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly failure: CalendarFailure,
    readonly status: number | null,
  ) {
    super(SENTENCES[failure](status));
    this.name = 'CalendarSyncError';
    this.retryable = failure === 'unavailable';
  }
}

/**
 * The workspace calendar (US-MTG-04..08), as the meeting sync needs it.
 *
 * A port, like `SmsProvider`: the sync service depends on this and the app
 * binds Google, the dev fake, or `off` from config (`CalendarModule`).
 * `enabled` lets the caller tell "nothing is configured" from "the call
 * failed" without reading config or classifying an exception.
 *
 * Every method throws {@link CalendarSyncError} on failure, and nothing else
 * that a caller is expected to handle.
 */
export abstract class CalendarProvider {
  abstract readonly enabled: boolean;
  /** A short-lived access token from the stored refresh token. Never stored. */
  abstract accessToken(refreshToken: string): Promise<string>;
  /** Create or update the event; `exists` says which to try first. */
  abstract upsertEvent(
    accessToken: string,
    event: CalendarEventInput,
    exists: boolean,
  ): Promise<CalendarEventResult>;
  /** Withdraw the invite. An event that is already gone counts as success. */
  abstract cancelEvent(
    accessToken: string,
    eventId: string,
    cancelNote: string | null,
  ): Promise<void>;
}

/**
 * The Google event id for a meeting: its uuid without the hyphens — 32
 * lowercase hex characters, which is valid base32hex.
 *
 * Deterministic on purpose. A cancel that overtakes an in-flight create, a
 * retry after a timeout whose insert actually landed, a resync after a
 * reconnect — all of them name the same event, so none can leave a second
 * invite behind on the guest's calendar.
 */
export const googleEventIdOf = (meetingId: string): string =>
  meetingId.replace(/-/g, '');
