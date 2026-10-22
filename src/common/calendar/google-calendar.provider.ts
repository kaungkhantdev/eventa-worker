import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import {
  type CalendarEventInput,
  type CalendarEventResult,
  type CalendarFailure,
  CalendarProvider,
  CalendarSyncError,
} from './calendar.provider';

/** Google's OAuth token endpoint — the same one eventa-api exchanged the code at. */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** The connecting account's PRIMARY calendar, and only that one (least privilege). */
const EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** Create/update: mint a Meet link if asked, and email the guest the invite. */
const UPSERT_QUERY = 'conferenceDataVersion=1&sendUpdates=all';
/** Writing the cancellation reason must not mail the guest an "updated" invite… */
const QUIET_QUERY = 'sendUpdates=none';
/** …the delete that follows it is what tells them. */
const NOTIFY_QUERY = 'sendUpdates=all';

/** Meeting times are Bangkok wall clock, as the organizer typed them. */
const BANGKOK = 'Asia/Bangkok';
/** US-MTG-04 AC2's reminder. Applied to the workspace calendar's copy. */
const REMINDER_MINUTES = 15;
const MEET_SOLUTION = 'hangoutsMeet';

/** One call may hold a consumer this long; the retry ladder covers the rest. */
const REQUEST_TIMEOUT_MS = 10_000;

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
/** The event is not there (any more): a patch falls back to insert; a cancel is done. */
const GONE = new Set([404, 410]);

/** The token endpoint's word for a refresh token that no longer works. */
const INVALID_GRANT = 'invalid_grant';
/** A 403 that is Google's rate limiting, not a refusal: worth waiting out. */
const QUOTA_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);
/** A 403 that means the grant lost the calendar scope: only a reconnect helps. */
const REVOKED_REASON = 'insufficientPermissions';

export interface CalendarFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/**
 * Just enough of `fetch` to send one request and read one JSON body. Injected
 * so the spec needs no network — the same arrangement as `TwilioSmsProvider`.
 */
export type CalendarFetch = (
  url: string,
  init: CalendarFetchInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

type Answer = Awaited<ReturnType<CalendarFetch>>;

/** The few fields of a Calendar event resource this reads. */
interface GoogleEvent {
  id?: unknown;
  hangoutLink?: unknown;
  conferenceData?: {
    entryPoints?: { entryPointType?: unknown; uri?: unknown }[];
    createRequest?: { status?: { statusCode?: unknown } };
  };
}

/**
 * The workspace's Google Calendar, over its REST API (US-MTG-04..08).
 *
 * Plain `fetch` and no SDK, as with Twilio: a handful of JSON calls, and a
 * vendor SDK would bring its own retry policy and logging to a path where both
 * are already decided — retries by the consumer's ladder, logging by ids only.
 *
 * NOTHING THIS CLASS THROWS CARRIES GOOGLE'S WORDS. A Calendar error body can
 * quote the guest's address and the event's title, and the error message here
 * becomes `meetings.sync_error`, which the organizer reads. So a failure is
 * only ever one of three fixed sentences plus, for a refusal, the HTTP status
 * (`CalendarSyncError`). Tokens never appear in a message or a log.
 *
 * UNPROVEN AGAINST A REAL ACCOUNT. Every test runs against a stubbed fetch, so
 * the requests are verified and the live API's behaviour is not.
 */
@Injectable()
export class GoogleCalendarProvider extends CalendarProvider {
  readonly enabled = true;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly fetchImpl: CalendarFetch = globalThis.fetch,
  ) {
    super();
    this.clientId = config.getOrThrow('GOOGLE_CALENDAR_CLIENT_ID', {
      infer: true,
    });
    this.clientSecret = config.getOrThrow('GOOGLE_CALENDAR_CLIENT_SECRET', {
      infer: true,
    });
  }

  async accessToken(refreshToken: string): Promise<string> {
    const response = await this.send(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': FORM },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!response.ok) throw await tokenFailure(response);
    const body = (await readJson(response)) as { access_token?: unknown };
    if (typeof body.access_token === 'string' && body.access_token)
      return body.access_token;
    // A 2xx with no token is Google misbehaving, not refusing: try again.
    throw new CalendarSyncError('unavailable', response.status);
  }

  async upsertEvent(
    accessToken: string,
    input: CalendarEventInput,
    exists: boolean,
  ): Promise<CalendarEventResult> {
    const response = await this.upsert(accessToken, input, exists);
    if (!response.ok) throw await calendarFailure(response);
    return resultOf(await readJson(response), input.eventId);
  }

  /**
   * Patch first when the event should exist, insert first when it should not —
   * and at most ONE fallback either way: a patch that finds it gone inserts,
   * an insert that finds the id taken patches. A second surprise is a refusal.
   */
  private async upsert(
    accessToken: string,
    input: CalendarEventInput,
    exists: boolean,
  ): Promise<Answer> {
    if (exists) {
      const patched = await this.patch(accessToken, input);
      return GONE.has(patched.status)
        ? this.insert(accessToken, input)
        : patched;
    }
    const inserted = await this.insert(accessToken, input);
    return inserted.status === HTTP_CONFLICT
      ? this.patch(accessToken, input)
      : inserted;
  }

  private insert(accessToken: string, input: CalendarEventInput) {
    return this.call(
      accessToken,
      'POST',
      `${EVENTS_URL}?${UPSERT_QUERY}`,
      insertBody(input),
    );
  }

  private patch(accessToken: string, input: CalendarEventInput) {
    return this.call(
      accessToken,
      'PATCH',
      `${eventUrl(input.eventId)}?${UPSERT_QUERY}`,
      patchBody(input),
    );
  }

  /**
   * The reason goes into the description first, without notifying anybody,
   * so the cancellation Google then mails the guest can carry it (US-MTG-06).
   * An event that is already gone is already cancelled.
   */
  async cancelEvent(
    accessToken: string,
    eventId: string,
    cancelNote: string | null,
  ): Promise<void> {
    if (cancelNote) {
      const noted = await this.call(
        accessToken,
        'PATCH',
        `${eventUrl(eventId)}?${QUIET_QUERY}`,
        { description: cancelNote },
      );
      if (GONE.has(noted.status)) return;
      if (!noted.ok) throw await calendarFailure(noted);
    }
    const deleted = await this.call(
      accessToken,
      'DELETE',
      `${eventUrl(eventId)}?${NOTIFY_QUERY}`,
    );
    if (deleted.ok || GONE.has(deleted.status)) return;
    throw await calendarFailure(deleted);
  }

  private call(
    accessToken: string,
    method: string,
    url: string,
    body?: object,
  ): Promise<Answer> {
    return this.send(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': JSON_TYPE,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Every request, with a timeout; a network failure is an outage. */
  private async send(
    url: string,
    init: Omit<CalendarFetchInit, 'signal'>,
  ): Promise<Answer> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // A timeout or a refused connection says nothing about the meeting, so
      // it is always worth another attempt. The cause is not kept: it is a
      // network error at best, and nothing about it is safe to repeat.
      throw new CalendarSyncError('unavailable', null);
    }
  }
}

const eventUrl = (eventId: string): string =>
  `${EVENTS_URL}/${encodeURIComponent(eventId)}`;

const timed = (local: string) => ({ dateTime: local, timeZone: BANGKOK });

/** The fields an insert and a patch both send. */
function shared(input: CalendarEventInput) {
  return {
    summary: input.summary,
    description: input.description,
    start: timed(input.startLocal),
    end: timed(input.endLocal),
    attendees: [{ email: input.guestEmail, displayName: input.guestName }],
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: REMINDER_MINUTES }],
    },
  };
}

const createRequestOf = (input: CalendarEventInput) => ({
  createRequest: {
    requestId: input.conferenceRequestId,
    conferenceSolutionKey: { type: MEET_SOLUTION },
  },
});

/**
 * A new event carries the deterministic id, and a conference request unless
 * the meeting is not a video call — a new event has no link to keep, so
 * `keep` asks for one too.
 */
function insertBody(input: CalendarEventInput) {
  return {
    id: input.eventId,
    ...shared(input),
    ...(input.location === null ? {} : { location: input.location }),
    ...(input.meet === 'remove'
      ? {}
      : { conferenceData: createRequestOf(input) }),
  };
}

/** What a patch says about the conference: mint, leave alone, or take away. */
const CONFERENCE_PATCH: Record<
  CalendarEventInput['meet'],
  (input: CalendarEventInput) => object
> = {
  create: (input) => ({ conferenceData: createRequestOf(input) }),
  keep: () => ({}),
  remove: () => ({ conferenceData: null }),
};

/**
 * `status: 'confirmed'` restores an event a cancel deleted, so a meeting
 * cancelled and then re-saved under the same id comes back rather than 404ing.
 */
function patchBody(input: CalendarEventInput) {
  return {
    ...shared(input),
    location: input.location ?? null,
    status: 'confirmed',
    ...CONFERENCE_PATCH[input.meet](input),
  };
}

function resultOf(
  event: GoogleEvent,
  requestedId: string,
): CalendarEventResult {
  return {
    eventId: typeof event.id === 'string' && event.id ? event.id : requestedId,
    meetLink: meetLinkOf(event),
    meetPending:
      event.conferenceData?.createRequest?.status?.statusCode === 'pending',
  };
}

function meetLinkOf(event: GoogleEvent): string | null {
  if (typeof event.hangoutLink === 'string') return event.hangoutLink;
  const video = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === 'video',
  );
  return typeof video?.uri === 'string' ? video.uri : null;
}

/** A body that is not JSON (a 204, an HTML error page) reads as empty. */
async function readJson(response: Pick<Answer, 'json'>): Promise<object> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? body : {};
  } catch {
    return {};
  }
}

/** The token endpoint: only `invalid_grant` means the connection is gone. */
async function tokenFailure(response: Answer): Promise<CalendarSyncError> {
  const { error } = (await readJson(response)) as { error?: unknown };
  return new CalendarSyncError(
    tokenFailureOf(response.status, error),
    response.status,
  );
}

function tokenFailureOf(status: number, error: unknown): CalendarFailure {
  if (status === HTTP_BAD_REQUEST && error === INVALID_GRANT)
    return 'auth_revoked';
  return isTransient(status) ? 'unavailable' : 'rejected';
}

/** The Calendar API (§5.6's table). */
async function calendarFailure(response: Answer): Promise<CalendarSyncError> {
  return new CalendarSyncError(
    await calendarFailureOf(response),
    response.status,
  );
}

async function calendarFailureOf(response: Answer): Promise<CalendarFailure> {
  // A 401 on a token minted seconds ago is Google's hiccup; the next attempt
  // refreshes a new one.
  if (response.status === HTTP_UNAUTHORIZED) return 'unavailable';
  if (response.status === HTTP_FORBIDDEN)
    return forbiddenFailureOf(await reasonOf(response));
  return isTransient(response.status) ? 'unavailable' : 'rejected';
}

/**
 * A 403 is three different things. Rate limits pass; a lost scope needs an
 * Admin to reconnect; anything else (accessNotConfigured, a disabled API) is
 * server configuration that reconnecting cannot fix — so it is NOT read as a
 * revoked grant, which would send the Admin round a useless reconnect loop.
 */
function forbiddenFailureOf(reason: string | undefined): CalendarFailure {
  if (reason !== undefined && QUOTA_REASONS.has(reason)) return 'unavailable';
  if (reason === REVOKED_REASON) return 'auth_revoked';
  return 'rejected';
}

/** `error.errors[0].reason` — read to classify, never repeated. */
async function reasonOf(response: Answer): Promise<string | undefined> {
  const body = (await readJson(response)) as {
    error?: { errors?: { reason?: unknown }[] };
  };
  const reason = body.error?.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

const isTransient = (status: number): boolean =>
  status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR;
