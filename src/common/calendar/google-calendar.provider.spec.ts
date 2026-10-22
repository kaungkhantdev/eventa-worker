import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import {
  CalendarSyncError,
  type CalendarEventInput,
} from './calendar.provider';
import {
  GoogleCalendarProvider,
  type CalendarFetch,
  type CalendarFetchInit,
} from './google-calendar.provider';

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'client-secret-value';
const REFRESH = '1//0e-refresh-token';
const ACCESS = 'ya29.access-token';
const EVENT_ID = '3f2b8c1e9a4d4e6f8b7a0c1d2e3f4a5b';
const GUEST = 'somchai@example.test';

const EVENTS =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const config = {
  getOrThrow: (key: keyof Env) =>
    ({
      GOOGLE_CALENDAR_CLIENT_ID: CLIENT_ID,
      GOOGLE_CALENDAR_CLIENT_SECRET: CLIENT_SECRET,
    })[key as string],
} as unknown as ConfigService<Env, true>;

type Answer = Awaited<ReturnType<CalendarFetch>>;

/** A response; `body` undefined means one that is not JSON (e.g. a 204). */
const answer = (status: number, body?: unknown): Answer => ({
  ok: status >= 200 && status < 300,
  status,
  json: () =>
    body === undefined
      ? Promise.reject(new SyntaxError('Unexpected end of JSON input'))
      : Promise.resolve(body),
});

/** Google's error envelope, carrying text that must never travel further. */
const googleError = (status: number, reason?: string) =>
  answer(status, {
    error: {
      code: status,
      message: `Calendar refused for ${GUEST}: "Venue walkthrough"`,
      errors: reason
        ? [{ domain: 'global', reason, message: `${reason} for ${GUEST}` }]
        : [],
    },
  });

const created = (over: Record<string, unknown> = {}) =>
  answer(200, {
    id: EVENT_ID,
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    conferenceData: {
      createRequest: { status: { statusCode: 'success' } },
      entryPoints: [
        {
          entryPointType: 'video',
          uri: 'https://meet.google.com/abc-defg-hij',
        },
      ],
    },
    ...over,
  });

const input = (over: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  eventId: EVENT_ID,
  summary: 'Venue walkthrough',
  description: 'Bring the floor plan',
  location: 'Queen Sirikit Convention Centre',
  startLocal: '2026-10-21T14:00:00',
  endLocal: '2026-10-21T15:00:00',
  guestEmail: GUEST,
  guestName: 'Somchai Jaidee',
  meet: 'create',
  conferenceRequestId: 'meeting-uuid-v3',
  ...over,
});

const createRequest = {
  createRequest: {
    requestId: 'meeting-uuid-v3',
    conferenceSolutionKey: { type: 'hangoutsMeet' },
  },
};

const common = {
  summary: 'Venue walkthrough',
  description: 'Bring the floor plan',
  start: { dateTime: '2026-10-21T14:00:00', timeZone: 'Asia/Bangkok' },
  end: { dateTime: '2026-10-21T15:00:00', timeZone: 'Asia/Bangkok' },
  attendees: [{ email: GUEST, displayName: 'Somchai Jaidee' }],
  reminders: {
    useDefault: false,
    overrides: [{ method: 'popup', minutes: 15 }],
  },
};

describe('GoogleCalendarProvider', () => {
  let fetchImpl: jest.MockedFunction<CalendarFetch>;
  let google: GoogleCalendarProvider;

  const call = (n: number): [string, CalendarFetchInit] =>
    fetchImpl.mock.calls[n];
  const bodyOf = (n: number): Record<string, unknown> =>
    JSON.parse(String(call(n)[1].body)) as Record<string, unknown>;

  beforeEach(() => {
    fetchImpl = jest.fn();
    google = new GoogleCalendarProvider(config, fetchImpl);
  });

  it('is enabled', () => {
    expect(google.enabled).toBe(true);
  });

  describe('accessToken', () => {
    it('trades the refresh token at Google’s token endpoint', async () => {
      fetchImpl.mockResolvedValue(
        answer(200, { access_token: ACCESS, expires_in: 3599 }),
      );

      await expect(google.accessToken(REFRESH)).resolves.toBe(ACCESS);

      const [url, init] = call(0);
      expect(url).toBe(TOKEN_URL);
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
      const form = new URLSearchParams(String(init.body));
      expect(Object.fromEntries(form)).toEqual({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH,
        grant_type: 'refresh_token',
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('reads invalid_grant as a revoked connection', async () => {
      fetchImpl.mockResolvedValue(
        answer(400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        }),
      );

      await expect(google.accessToken(REFRESH)).rejects.toMatchObject({
        failure: 'auth_revoked',
        status: 400,
        retryable: false,
      });
    });

    it.each([
      [400, 'invalid_client'],
      [401, 'unauthorized_client'],
    ])('reads any other %i (%s) as a refusal', async (status, error) => {
      fetchImpl.mockResolvedValue(answer(status, { error }));

      await expect(google.accessToken(REFRESH)).rejects.toMatchObject({
        failure: 'rejected',
        status,
        retryable: false,
      });
    });

    it.each([429, 500, 503])('reads %i as an outage', async (status) => {
      fetchImpl.mockResolvedValue(answer(status, { error: 'backendError' }));

      await expect(google.accessToken(REFRESH)).rejects.toMatchObject({
        failure: 'unavailable',
        retryable: true,
      });
    });

    it('reads a network failure or a timeout as an outage', async () => {
      fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(google.accessToken(REFRESH)).rejects.toMatchObject({
        failure: 'unavailable',
        status: null,
      });

      fetchImpl.mockRejectedValueOnce(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      );
      await expect(google.accessToken(REFRESH)).rejects.toMatchObject({
        failure: 'unavailable',
      });
    });

    it('never repeats Google’s words — or the token — in its message', async () => {
      fetchImpl.mockResolvedValue(
        answer(400, {
          error: 'invalid_grant',
          error_description: `Bad token ${REFRESH} for ${GUEST}`,
        }),
      );

      const err = await google.accessToken(REFRESH).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CalendarSyncError);
      const text = JSON.stringify({
        ...(err as object),
        m: (err as Error).message,
      });
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain(GUEST);
      expect(text).not.toContain('Bad token');
      expect(text).not.toContain(CLIENT_SECRET);
    });
  });

  describe('upsertEvent — a meeting Google has not seen (insert first)', () => {
    it('inserts with Meet, the guest invite and a 15-minute reminder', async () => {
      fetchImpl.mockResolvedValue(created());

      await google.upsertEvent(ACCESS, input(), false);

      const [url, init] = call(0);
      expect(url).toBe(`${EVENTS}?conferenceDataVersion=1&sendUpdates=all`);
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${ACCESS}`);
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(bodyOf(0)).toEqual({
        id: EVENT_ID,
        ...common,
        location: 'Queen Sirikit Convention Centre',
        conferenceData: createRequest,
      });
    });

    it('omits a location the meeting does not have', async () => {
      fetchImpl.mockResolvedValue(created());

      await google.upsertEvent(ACCESS, input({ location: null }), false);

      expect('location' in bodyOf(0)).toBe(false);
    });

    it('asks for no conference when the meeting is not a video call', async () => {
      fetchImpl.mockResolvedValue(created({ hangoutLink: undefined }));

      await google.upsertEvent(ACCESS, input({ meet: 'remove' }), false);

      expect('conferenceData' in bodyOf(0)).toBe(false);
    });

    it('asks for a conference on insert even when told to keep one', async () => {
      // An event that does not exist yet has no link to keep.
      fetchImpl.mockResolvedValue(created());

      await google.upsertEvent(ACCESS, input({ meet: 'keep' }), false);

      expect(bodyOf(0).conferenceData).toEqual(createRequest);
    });

    it('answers with the event id and the Meet link', async () => {
      fetchImpl.mockResolvedValue(created());

      await expect(google.upsertEvent(ACCESS, input(), false)).resolves.toEqual(
        {
          eventId: EVENT_ID,
          meetLink: 'https://meet.google.com/abc-defg-hij',
          meetPending: false,
        },
      );
    });

    it('falls back to the video entry point when there is no hangoutLink', async () => {
      fetchImpl.mockResolvedValue(
        created({
          hangoutLink: undefined,
          conferenceData: {
            entryPoints: [
              { entryPointType: 'phone', uri: 'tel:+66-2-000-0000' },
              {
                entryPointType: 'video',
                uri: 'https://meet.google.com/xyz-abcd-efg',
              },
            ],
          },
        }),
      );

      const result = await google.upsertEvent(ACCESS, input(), false);
      expect(result.meetLink).toBe('https://meet.google.com/xyz-abcd-efg');
    });

    it('reports a Meet link Google has not minted yet', async () => {
      fetchImpl.mockResolvedValue(
        answer(200, {
          id: EVENT_ID,
          conferenceData: {
            createRequest: { status: { statusCode: 'pending' } },
          },
        }),
      );

      await expect(google.upsertEvent(ACCESS, input(), false)).resolves.toEqual(
        {
          eventId: EVENT_ID,
          meetLink: null,
          meetPending: true,
        },
      );
    });

    it('patches instead when the id is already taken (409), once', async () => {
      fetchImpl
        .mockResolvedValueOnce(googleError(409, 'duplicate'))
        .mockResolvedValueOnce(created());

      await google.upsertEvent(ACCESS, input(), false);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(call(1)[0]).toBe(
        `${EVENTS}/${EVENT_ID}?conferenceDataVersion=1&sendUpdates=all`,
      );
      expect(call(1)[1].method).toBe('PATCH');
    });

    it('never falls back twice', async () => {
      fetchImpl
        .mockResolvedValueOnce(googleError(409, 'duplicate'))
        .mockResolvedValueOnce(googleError(404, 'notFound'))
        .mockResolvedValue(created());

      await expect(
        google.upsertEvent(ACCESS, input(), false),
      ).rejects.toMatchObject({ failure: 'rejected', status: 404 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('upsertEvent — a meeting Google already has (patch first)', () => {
    it('patches the event, restoring it if it was deleted', async () => {
      fetchImpl.mockResolvedValue(created());

      await google.upsertEvent(ACCESS, input(), true);

      const [url, init] = call(0);
      expect(url).toBe(
        `${EVENTS}/${EVENT_ID}?conferenceDataVersion=1&sendUpdates=all`,
      );
      expect(init.method).toBe('PATCH');
      expect(init.headers.Authorization).toBe(`Bearer ${ACCESS}`);
      expect(bodyOf(0)).toEqual({
        ...common,
        location: 'Queen Sirikit Convention Centre',
        status: 'confirmed',
        conferenceData: createRequest,
      });
    });

    it('clears a location the meeting no longer has', async () => {
      fetchImpl.mockResolvedValue(created());

      await google.upsertEvent(ACCESS, input({ location: null }), true);

      expect(bodyOf(0).location).toBeNull();
    });

    it('leaves the conference alone when keeping the link', async () => {
      fetchImpl.mockResolvedValue(created());

      await google.upsertEvent(ACCESS, input({ meet: 'keep' }), true);

      expect('conferenceData' in bodyOf(0)).toBe(false);
    });

    it('removes the conference when the meeting stops being a video call', async () => {
      fetchImpl.mockResolvedValue(created({ hangoutLink: undefined }));

      await google.upsertEvent(ACCESS, input({ meet: 'remove' }), true);

      expect(bodyOf(0).conferenceData).toBeNull();
    });

    it.each([404, 410])(
      'inserts instead when the event is gone (%i), once',
      async (status) => {
        fetchImpl
          .mockResolvedValueOnce(googleError(status, 'notFound'))
          .mockResolvedValueOnce(created());

        await google.upsertEvent(ACCESS, input(), true);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(call(1)[0]).toBe(
          `${EVENTS}?conferenceDataVersion=1&sendUpdates=all`,
        );
        expect(call(1)[1].method).toBe('POST');
        expect(bodyOf(1).id).toBe(EVENT_ID);
      },
    );

    it('never falls back twice', async () => {
      fetchImpl
        .mockResolvedValueOnce(googleError(404, 'notFound'))
        .mockResolvedValueOnce(googleError(409, 'duplicate'))
        .mockResolvedValue(created());

      await expect(
        google.upsertEvent(ACCESS, input(), true),
      ).rejects.toMatchObject({
        failure: 'rejected',
        status: 409,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancelEvent', () => {
    it('writes the reason quietly, then deletes with notice to the guest', async () => {
      fetchImpl
        .mockResolvedValueOnce(created())
        .mockResolvedValueOnce(answer(204));

      await google.cancelEvent(ACCESS, EVENT_ID, 'Cancelled: Venue closed');

      expect(call(0)[0]).toBe(`${EVENTS}/${EVENT_ID}?sendUpdates=none`);
      expect(call(0)[1].method).toBe('PATCH');
      expect(bodyOf(0)).toEqual({ description: 'Cancelled: Venue closed' });
      expect(call(1)[0]).toBe(`${EVENTS}/${EVENT_ID}?sendUpdates=all`);
      expect(call(1)[1].method).toBe('DELETE');
      expect(call(1)[1].headers.Authorization).toBe(`Bearer ${ACCESS}`);
    });

    it('only deletes when there is no reason to write', async () => {
      fetchImpl.mockResolvedValueOnce(answer(204));

      await google.cancelEvent(ACCESS, EVENT_ID, null);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(call(0)[1].method).toBe('DELETE');
    });

    it.each([404, 410])(
      'treats an event already gone (%i) as done',
      async (status) => {
        fetchImpl.mockResolvedValue(googleError(status, 'deleted'));

        await expect(
          google.cancelEvent(ACCESS, EVENT_ID, 'Cancelled: Venue closed'),
        ).resolves.toBeUndefined();
        await expect(
          google.cancelEvent(ACCESS, EVENT_ID, null),
        ).resolves.toBeUndefined();
      },
    );

    it('reads a failed delete like any other call', async () => {
      fetchImpl.mockResolvedValue(googleError(503, 'backendError'));

      await expect(
        google.cancelEvent(ACCESS, EVENT_ID, null),
      ).rejects.toMatchObject({
        failure: 'unavailable',
        retryable: true,
      });
    });
  });

  describe('what a Calendar API failure means', () => {
    const outcomeOf = async (response: Answer): Promise<CalendarSyncError> => {
      fetchImpl.mockResolvedValue(response);
      try {
        await google.upsertEvent(ACCESS, input(), false);
      } catch (e) {
        return e as CalendarSyncError;
      }
      throw new Error('expected the call to fail');
    };

    it('retries a 401 — the next attempt gets a fresh token', async () => {
      await expect(
        outcomeOf(googleError(401, 'authError')),
      ).resolves.toMatchObject({
        failure: 'unavailable',
        retryable: true,
      });
    });

    it.each([
      'rateLimitExceeded',
      'userRateLimitExceeded',
      'quotaExceeded',
      'dailyLimitExceeded',
    ])('retries a quota 403 (%s)', async (reason) => {
      await expect(outcomeOf(googleError(403, reason))).resolves.toMatchObject({
        failure: 'unavailable',
        status: 403,
        retryable: true,
      });
    });

    it('reads insufficientPermissions as a revoked grant', async () => {
      await expect(
        outcomeOf(googleError(403, 'insufficientPermissions')),
      ).resolves.toMatchObject({ failure: 'auth_revoked', retryable: false });
    });

    it.each([['accessNotConfigured'], ['forbidden'], [undefined]])(
      'refuses any other 403 (%s) — reconnecting cannot fix it',
      async (reason) => {
        await expect(
          outcomeOf(googleError(403, reason)),
        ).resolves.toMatchObject({
          failure: 'rejected',
          status: 403,
          retryable: false,
        });
      },
    );

    it('refuses a 403 whose body is not JSON', async () => {
      await expect(outcomeOf(answer(403))).resolves.toMatchObject({
        failure: 'rejected',
      });
    });

    it.each([429, 500, 502, 503])('retries %i', async (status) => {
      await expect(outcomeOf(googleError(status))).resolves.toMatchObject({
        failure: 'unavailable',
        retryable: true,
      });
    });

    it('refuses a 400', async () => {
      const err = await outcomeOf(googleError(400, 'invalid'));
      expect(err).toMatchObject({ failure: 'rejected', retryable: false });
      expect(err.message).toBe(
        'Google Calendar refused the request (HTTP 400).',
      );
    });

    it('retries a network failure and a timeout', async () => {
      fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(
        google.upsertEvent(ACCESS, input(), false),
      ).rejects.toMatchObject({ failure: 'unavailable', retryable: true });

      fetchImpl.mockRejectedValueOnce(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      );
      await expect(
        google.upsertEvent(ACCESS, input(), false),
      ).rejects.toMatchObject({ failure: 'unavailable', retryable: true });
    });

    it('never carries a word of the response body', async () => {
      for (const response of [
        googleError(400, 'invalid'),
        googleError(403, 'accessNotConfigured'),
        googleError(403, 'insufficientPermissions'),
        googleError(403, 'quotaExceeded'),
        googleError(500, 'backendError'),
      ]) {
        const err = await outcomeOf(response);
        const text = JSON.stringify({ ...err, m: err.message });
        expect(text).not.toContain(GUEST);
        expect(text).not.toContain('Venue walkthrough');
        expect(text).not.toContain('Calendar refused for');
        expect(text).not.toMatch(
          /accessNotConfigured|insufficientPermissions|quotaExceeded|backendError/,
        );
        expect(text).not.toContain(ACCESS);
      }
    });
  });
});
