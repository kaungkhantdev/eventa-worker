import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  type CalendarEventInput,
  type CalendarEventResult,
  CalendarProvider,
  CalendarSyncError,
} from '../../common/calendar/calendar.provider';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import {
  DEV_SECRET_ENCRYPTION_KEY,
  type Env,
} from '../../config/env.validation';
import { isRetryable } from '../../rabbitmq/failure';
import type {
  CalendarConnectionsRepository,
  ConnectionForSync,
} from './calendar-connections.repository';
import {
  MeetingCalendarSyncService,
  OUTCOME,
} from './meeting-calendar-sync.service';
import {
  MeetingSyncFailure,
  MeetingSyncRetry,
  UNREADABLE_CONNECTION_SENTENCE,
} from './meeting-sync.errors';
import type {
  MeetingForSync,
  MeetingsRepository,
  SyncOutcomePatch,
} from './meetings.repository';

const ORG = 7;
const MEETING_ID = '3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b';
const EVENT_ID = '3f2b8c1e9a4d4e6f8b7a0c1d2e3f4a5b';
const SEEN = '2026-10-20 07:43:44.123456+00';
const GUEST = 'somchai@example.test';
const PERSON = 'Somchai Jaidee';
const TITLE = 'Venue walkthrough';
const NOTES = 'Bring the floor plan';
const REFRESH = '1//0e-refresh-token-secret';
const ACCESS = 'ya29.access-token-secret';
const MEET = 'https://meet.google.com/abc-defg-hij';

const EXPIRED = 'The Google Calendar connection has expired.';

const cipher = new SecretCipher({
  getOrThrow: () => DEV_SECRET_ENCRYPTION_KEY,
} as unknown as ConfigService<Env, true>);

const meeting = (over: Partial<MeetingForSync> = {}): MeetingForSync => ({
  id: MEETING_ID,
  organizationId: ORG,
  title: TITLE,
  meetingDate: '2026-10-21',
  startTime: '14:00:00',
  endTime: '15:30:00',
  mode: 'Video',
  status: 'scheduled',
  syncStatus: 'pending',
  person: PERSON,
  guestEmail: GUEST,
  location: null,
  notes: NOTES,
  link: null,
  cancellationReason: null,
  externalEventId: null,
  syncError: null,
  version: 3,
  deletedAt: null,
  updatedAt: SEEN,
  ...over,
});

const connected = (): ConnectionForSync => ({
  status: 'connected',
  refreshTokenCipher: cipher.encrypt(REFRESH),
});

/** A calendar that records what it was asked to do. */
class RecordingCalendar extends CalendarProvider {
  enabled = true;
  readonly upserts: { input: CalendarEventInput; exists: boolean }[] = [];
  readonly cancels: { eventId: string; note: string | null }[] = [];
  result: CalendarEventResult = {
    eventId: EVENT_ID,
    meetLink: MEET,
    meetPending: false,
  };
  accessToken(refreshToken: string): Promise<string> {
    void refreshToken;
    return Promise.resolve(ACCESS);
  }

  upsertEvent(
    accessToken: string,
    input: CalendarEventInput,
    exists: boolean,
  ): Promise<CalendarEventResult> {
    expect(accessToken).toBe(ACCESS);
    this.upserts.push({ input, exists });
    return Promise.resolve(this.result);
  }

  cancelEvent(
    accessToken: string,
    eventId: string,
    note: string | null,
  ): Promise<void> {
    expect(accessToken).toBe(ACCESS);
    this.cancels.push({ eventId, note });
    return Promise.resolve();
  }
}

describe('MeetingCalendarSyncService.reconcile (US-MTG-04..08)', () => {
  let row: MeetingForSync | null;
  let connection: ConnectionForSync | null;
  let superseded: boolean;
  let calendar: RecordingCalendar;
  let accessToken: jest.SpyInstance<Promise<string>, [string]>;
  let meetings: jest.Mocked<MeetingsRepository>;
  let connections: jest.Mocked<CalendarConnectionsRepository>;
  let sync: MeetingCalendarSyncService;

  /** Every outcome patch written, in order. */
  const written = (): SyncOutcomePatch[] =>
    meetings.writeOutcome.mock.calls.map((call) => call[3]);

  beforeEach(() => {
    row = meeting();
    connection = connected();
    superseded = false;
    calendar = new RecordingCalendar();
    accessToken = jest.spyOn(calendar, 'accessToken');
    meetings = {
      findForSync: jest.fn(() => Promise.resolve(row)),
      writeOutcome: jest.fn(() => Promise.resolve(!superseded)),
      recordExternalId: jest.fn(() => Promise.resolve()),
    } as unknown as jest.Mocked<MeetingsRepository>;
    connections = {
      find: jest.fn(() => Promise.resolve(connection)),
      markExpired: jest.fn(() => Promise.resolve()),
    } as unknown as jest.Mocked<CalendarConnectionsRepository>;
    sync = new MeetingCalendarSyncService(
      meetings,
      connections,
      calendar,
      cipher,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('1–2: nothing to do', () => {
    it('is gone when the meeting does not exist', async () => {
      row = null;

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(OUTCOME.gone);
      expect(meetings.findForSync).toHaveBeenCalledWith(ORG, MEETING_ID);
      expect(meetings.writeOutcome).not.toHaveBeenCalled();
      expect(accessToken).not.toHaveBeenCalled();
    });

    it('is gone when the meeting was deleted', async () => {
      row = meeting({ deletedAt: new Date() });

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(OUTCOME.gone);
      expect(meetings.writeOutcome).not.toHaveBeenCalled();
    });

    it('calls nobody for a meeting that is already synced', async () => {
      // A redelivery, or an older message overtaken by a newer one.
      row = meeting({ syncStatus: 'synced' });

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.already_synced,
      );
      expect(accessToken).not.toHaveBeenCalled();
      expect(meetings.writeOutcome).not.toHaveBeenCalled();
    });
  });

  describe('3: no usable connection (US-MTG-08 AC2)', () => {
    it('marks a meeting not connected when the workspace never connected', async () => {
      connection = null;

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.not_connected,
      );
      expect(meetings.writeOutcome).toHaveBeenCalledWith(
        ORG,
        MEETING_ID,
        SEEN,
        { syncStatus: 'not_connected', syncError: null },
      );
      expect(accessToken).not.toHaveBeenCalled();
    });

    it('marks it not connected after a disconnect', async () => {
      connection = { status: 'disconnected', refreshTokenCipher: null };

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.not_connected,
      );
      expect(written()).toEqual([
        { syncStatus: 'not_connected', syncError: null },
      ]);
    });

    it('says the connection expired when it did', async () => {
      connection = { ...connected(), status: 'expired' };

      await sync.reconcile(ORG, MEETING_ID);

      expect(written()).toEqual([
        { syncStatus: 'not_connected', syncError: EXPIRED },
      ]);
      expect(accessToken).not.toHaveBeenCalled();
    });

    it('marks it not connected when this worker has no calendar configured', async () => {
      calendar.enabled = false;

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.not_connected,
      );
      expect(accessToken).not.toHaveBeenCalled();
    });

    it('does not trust a connected row with no token', async () => {
      connection = { status: 'connected', refreshTokenCipher: null };

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.not_connected,
      );
    });

    it('settles a cancellation nobody was ever invited to', async () => {
      // No event id was ever recorded and nothing is connected: there is no
      // invite anywhere reachable to withdraw.
      row = meeting({ status: 'cancelled', cancellationReason: 'Closed' });
      connection = null;

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.synced,
      );
      expect(written()).toEqual([{ syncStatus: 'synced', syncError: null }]);
    });

    it('leaves a cancellation with a live invite waiting for a reconnect', async () => {
      row = meeting({ status: 'cancelled', externalEventId: EVENT_ID });
      connection = null;

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.not_connected,
      );
      expect(written()).toEqual([
        { syncStatus: 'not_connected', syncError: null },
      ]);
    });

    it('is superseded when the organizer changed the meeting meanwhile', async () => {
      connection = null;
      superseded = true;

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.superseded,
      );
    });
  });

  describe('4: a token that cannot be read', () => {
    it('records it and parks the message — the symptom of a key mismatch', async () => {
      connection = {
        status: 'connected',
        refreshTokenCipher: Buffer.from('not a cipher this key can open'),
      };

      const err = await sync
        .reconcile(ORG, MEETING_ID)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MeetingSyncFailure);
      expect(isRetryable(err)).toBe(false);
      expect(written()).toEqual([
        { syncStatus: 'failed', syncError: UNREADABLE_CONNECTION_SENTENCE },
      ]);
      expect(UNREADABLE_CONNECTION_SENTENCE).toBe(
        'The Google Calendar connection could not be read.',
      );
      expect(accessToken).not.toHaveBeenCalled();
    });
  });

  describe('5: the token', () => {
    it('trades the DECRYPTED refresh token for an access token', async () => {
      await sync.reconcile(ORG, MEETING_ID);

      expect(connections.find).toHaveBeenCalledWith(ORG);
      expect(accessToken).toHaveBeenCalledWith(REFRESH);
    });
  });

  describe('6: a cancelled meeting (US-MTG-06)', () => {
    it('withdraws the recorded event, with the reason and the notes', async () => {
      row = meeting({
        status: 'cancelled',
        externalEventId: 'recorded-event-id',
        cancellationReason: 'Venue closed',
      });

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.synced,
      );
      expect(calendar.cancels).toEqual([
        {
          eventId: 'recorded-event-id',
          note: `Cancelled: Venue closed\n\n${NOTES}`,
        },
      ]);
      expect(written()).toEqual([{ syncStatus: 'synced', syncError: null }]);
      expect(calendar.upserts).toHaveLength(0);
    });

    it('withdraws the deterministic id when none was recorded', async () => {
      // A create superseded by this cancel may already exist at Google.
      row = meeting({ status: 'cancelled', cancellationReason: 'Closed' });

      await sync.reconcile(ORG, MEETING_ID);

      expect(calendar.cancels[0].eventId).toBe(EVENT_ID);
    });

    it('writes just the reason when there are no notes', async () => {
      row = meeting({
        status: 'cancelled',
        cancellationReason: 'Venue closed',
        notes: null,
      });

      await sync.reconcile(ORG, MEETING_ID);

      expect(calendar.cancels[0].note).toBe('Cancelled: Venue closed');
    });

    it('writes no note when no reason was given', async () => {
      row = meeting({ status: 'cancelled', externalEventId: EVENT_ID });

      await sync.reconcile(ORG, MEETING_ID);

      expect(calendar.cancels[0].note).toBeNull();
    });
  });

  describe('7: a scheduled meeting (US-MTG-04/05/07)', () => {
    it('creates the event from the CURRENT row, with a Meet link', async () => {
      row = meeting({ location: null });

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.synced,
      );
      expect(calendar.upserts).toEqual([
        {
          exists: false,
          input: {
            eventId: EVENT_ID,
            summary: TITLE,
            description: NOTES,
            location: null,
            startLocal: '2026-10-21T14:00:00',
            endLocal: '2026-10-21T15:30:00',
            guestEmail: GUEST,
            guestName: PERSON,
            meet: 'create',
            conferenceRequestId: `${MEETING_ID}-v3`,
          },
        },
      ]);
      expect(meetings.recordExternalId).toHaveBeenCalledWith(
        ORG,
        MEETING_ID,
        EVENT_ID,
      );
      expect(written()).toEqual([
        { syncStatus: 'synced', syncError: null, link: MEET },
      ]);
    });

    it('sends an empty description when there are no notes', async () => {
      row = meeting({ notes: null });

      await sync.reconcile(ORG, MEETING_ID);

      expect(calendar.upserts[0].input.description).toBe('');
    });

    it('updates the recorded event and keeps its link on a reschedule', async () => {
      row = meeting({
        externalEventId: EVENT_ID,
        link: MEET,
        startTime: '16:00:00',
        endTime: '17:00:00',
      });
      calendar.result = {
        eventId: EVENT_ID,
        meetLink: null,
        meetPending: false,
      };

      await sync.reconcile(ORG, MEETING_ID);

      expect(calendar.upserts[0].exists).toBe(true);
      expect(calendar.upserts[0].input.meet).toBe('keep');
      expect(calendar.upserts[0].input.startLocal).toBe('2026-10-21T16:00:00');
      // Google may not echo the conference back; the link already held stands.
      expect(written()).toEqual([
        { syncStatus: 'synced', syncError: null, link: MEET },
      ]);
    });

    it('asks for a link when a recorded video event has none yet', async () => {
      row = meeting({ externalEventId: EVENT_ID, link: null });

      await sync.reconcile(ORG, MEETING_ID);

      expect(calendar.upserts[0].input.meet).toBe('create');
      expect(calendar.upserts[0].exists).toBe(true);
    });

    it.each(['In person', 'Phone'] as const)(
      'removes the Meet link from a meeting that is now %s',
      async (mode) => {
        row = meeting({
          mode,
          externalEventId: EVENT_ID,
          link: MEET,
          location: 'Queen Sirikit Convention Centre',
        });
        calendar.result = {
          eventId: EVENT_ID,
          meetLink: null,
          meetPending: false,
        };

        await sync.reconcile(ORG, MEETING_ID);

        expect(calendar.upserts[0].input.meet).toBe('remove');
        expect(calendar.upserts[0].input.location).toBe(
          'Queen Sirikit Convention Centre',
        );
        expect(written()).toEqual([
          { syncStatus: 'synced', syncError: null, link: null },
        ]);
      },
    );

    it('records the event id even when the outcome write is superseded', async () => {
      // The api never writes external_event_id, so losing it here would leave
      // the invite on the guest's calendar with nothing that can find it.
      superseded = true;

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.superseded,
      );
      expect(meetings.recordExternalId).toHaveBeenCalledWith(
        ORG,
        MEETING_ID,
        EVENT_ID,
      );
    });

    it('leaves the meeting pending and retries while Google mints the link', async () => {
      calendar.result = {
        eventId: EVENT_ID,
        meetLink: null,
        meetPending: true,
      };

      const err = await sync
        .reconcile(ORG, MEETING_ID)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MeetingSyncRetry);
      expect((err as MeetingSyncRetry).reason).toBe('link_pending');
      expect(isRetryable(err)).toBe(true);
      expect(meetings.writeOutcome).not.toHaveBeenCalled();
      expect(meetings.recordExternalId).toHaveBeenCalled();
    });

    it('uses the same conference request on that retry, so Google returns the same link', async () => {
      calendar.result = {
        eventId: EVENT_ID,
        meetLink: null,
        meetPending: true,
      };
      await sync.reconcile(ORG, MEETING_ID).catch(() => undefined);
      row = meeting({ externalEventId: EVENT_ID });
      calendar.result = {
        eventId: EVENT_ID,
        meetLink: MEET,
        meetPending: false,
      };

      await sync.reconcile(ORG, MEETING_ID);

      expect(calendar.upserts.map((u) => u.input.conferenceRequestId)).toEqual([
        `${MEETING_ID}-v3`,
        `${MEETING_ID}-v3`,
      ]);
    });
  });

  describe('8: when Google says no', () => {
    const failWith = (err: CalendarSyncError, at: 'token' | 'upsert') => {
      if (at === 'token') accessToken.mockRejectedValueOnce(err);
      else jest.spyOn(calendar, 'upsertEvent').mockRejectedValueOnce(err);
    };

    it.each(['token', 'upsert'] as const)(
      'marks the connection expired on a revoked grant (at %s), and acks',
      async (at) => {
        const seen = connection?.refreshTokenCipher;
        failWith(new CalendarSyncError('auth_revoked', 400), at);

        await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
          OUTCOME.connection_expired,
        );
        // Only for the cipher it used: a reconnect that landed mid-sync must
        // not be marked expired by a stale token.
        expect(connections.markExpired).toHaveBeenCalledWith(ORG, seen);
        expect(written()).toEqual([
          { syncStatus: 'not_connected', syncError: EXPIRED },
        ]);
      },
    );

    it('records an outage and hands the message to the retry ladder (US-MTG-04 AC4)', async () => {
      const outage = new CalendarSyncError('unavailable', 503);
      failWith(outage, 'upsert');

      await expect(sync.reconcile(ORG, MEETING_ID)).rejects.toBe(outage);
      expect(isRetryable(outage)).toBe(true);
      expect(written()).toEqual([
        {
          syncStatus: 'failed',
          syncError: 'Google Calendar is unavailable right now.',
        },
      ]);
      expect(connections.markExpired).not.toHaveBeenCalled();
    });

    it('records a refusal and parks the message', async () => {
      const refusal = new CalendarSyncError('rejected', 400);
      failWith(refusal, 'upsert');

      await expect(sync.reconcile(ORG, MEETING_ID)).rejects.toBe(refusal);
      expect(isRetryable(refusal)).toBe(false);
      expect(written()).toEqual([
        {
          syncStatus: 'failed',
          syncError: 'Google Calendar refused the request (HTTP 400).',
        },
      ]);
    });

    it('records a failed cancellation the same way', async () => {
      row = meeting({ status: 'cancelled', externalEventId: EVENT_ID });
      jest
        .spyOn(calendar, 'cancelEvent')
        .mockRejectedValueOnce(new CalendarSyncError('unavailable', 500));

      await expect(sync.reconcile(ORG, MEETING_ID)).rejects.toBeInstanceOf(
        CalendarSyncError,
      );
      expect(written()[0].syncStatus).toBe('failed');
    });

    it('does not rethrow a failure a newer change has superseded', async () => {
      // A newer message owns the meeting; retrying this one is pointless.
      superseded = true;
      failWith(new CalendarSyncError('unavailable', 503), 'upsert');

      await expect(sync.reconcile(ORG, MEETING_ID)).resolves.toBe(
        OUTCOME.superseded,
      );
    });

    it('lets anything that is not a calendar failure through untouched', async () => {
      const dbDown = Object.assign(new Error('connection terminated'), {
        code: '08006',
      });
      meetings.recordExternalId.mockRejectedValueOnce(dbDown);

      await expect(sync.reconcile(ORG, MEETING_ID)).rejects.toBe(dbDown);
      expect(meetings.writeOutcome).not.toHaveBeenCalled();
    });
  });

  /**
   * Every branch, with every log level watched: the guest's address and name,
   * the meeting's title and notes, and both tokens travel through this service
   * and none may reach a log line.
   */
  it('never logs the guest, the meeting or a token', async () => {
    const spies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    const run = () => sync.reconcile(ORG, MEETING_ID).catch(() => undefined);

    await run(); // synced
    row = meeting({ status: 'cancelled', cancellationReason: 'Closed' });
    await run(); // cancelled
    row = meeting();
    connection = null;
    await run(); // not connected
    connection = connected();
    accessToken.mockRejectedValueOnce(
      new CalendarSyncError('auth_revoked', 400),
    );
    await run(); // expired
    jest
      .spyOn(calendar, 'upsertEvent')
      .mockRejectedValueOnce(new CalendarSyncError('unavailable', 503));
    await run(); // outage
    calendar.result = { eventId: EVENT_ID, meetLink: null, meetPending: true };
    await run(); // link pending
    connection = { status: 'connected', refreshTokenCipher: Buffer.from('x') };
    await run(); // unreadable

    const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
    for (const secret of [GUEST, PERSON, TITLE, NOTES, REFRESH, ACCESS]) {
      expect(logged).not.toContain(secret);
    }
  });
});
