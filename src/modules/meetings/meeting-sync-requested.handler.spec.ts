import { Logger } from '@nestjs/common';
import { ZodError } from 'zod';
import { isRetryable } from '../../rabbitmq/failure';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { type MeetingCalendarSyncService } from './meeting-calendar-sync.service';
import { MeetingSyncRequestedHandler } from './meeting-sync-requested.handler';
import { MeetingSyncRetry } from './meeting-sync.errors';
import type { MeetingSyncLock } from './meeting-sync.lock';
import { OUTCOME } from '../../common/constants/meetings.constants';

const MEETING_ID = '3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b';
const GUEST = 'somchai@example.test';

const ctx: MessageContext = {
  routingKey: 'meeting.sync_requested',
  messageId: '4242',
  correlationId: 'corr-meeting',
};

/** Exactly the payload eventa-api's `meeting-sync.event.ts` builds (version 1). */
const rawEvent = {
  version: 1,
  organizationId: 7,
  meetingId: MEETING_ID,
  intent: 'create',
  title: 'Venue walkthrough',
  startsAt: '2026-10-21T07:00:00.000Z',
  endsAt: '2026-10-21T08:00:00.000Z',
  guestEmail: GUEST,
  person: 'Somchai Jaidee',
  mode: 'Video',
  needsLink: true,
  location: null,
  notes: 'Bring the floor plan',
  externalEventId: null,
  cancellationReason: null,
  occurredAt: '2026-10-20T07:00:00.000Z',
};

describe('MeetingSyncRequestedHandler (US-MTG-04..08)', () => {
  let sync: { reconcile: jest.Mock };
  let lock: { acquire: jest.Mock; release: jest.Mock };
  let handler: MeetingSyncRequestedHandler;
  let log: jest.SpyInstance;

  beforeEach(() => {
    sync = { reconcile: jest.fn().mockResolvedValue(OUTCOME.synced) };
    lock = {
      acquire: jest.fn().mockResolvedValue('lock-token'),
      release: jest.fn().mockResolvedValue(undefined),
    };
    handler = new MeetingSyncRequestedHandler(
      sync as unknown as MeetingCalendarSyncService,
      lock as unknown as MeetingSyncLock,
    );
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('binds the routing key eventa-api writes', () => {
    // An unbound key is discarded by the topic exchange without a trace.
    expect(handler.routingKey).toBe('meeting.sync_requested');
  });

  it('reconciles the meeting the message names, under its lock', async () => {
    await handler.handle(rawEvent, ctx);

    expect(lock.acquire).toHaveBeenCalledWith(MEETING_ID);
    expect(sync.reconcile).toHaveBeenCalledWith(7, MEETING_ID);
    expect(lock.release).toHaveBeenCalledWith(MEETING_ID, 'lock-token');
  });

  it('logs one line of ids and the outcome', async () => {
    await handler.handle(rawEvent, ctx);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      {
        correlationId: 'corr-meeting',
        messageId: '4242',
        organizationId: 7,
        meetingId: MEETING_ID,
        intent: 'create',
        outcome: OUTCOME.synced,
      },
      expect.any(String),
    );
  });

  describe('tolerant reader', () => {
    it('ignores the fields it does not use, and ones a newer producer adds', async () => {
      await expect(
        handler.handle({ ...rawEvent, version: 2, meetingVersion: 9 }, ctx),
      ).resolves.toBeUndefined();
      expect(sync.reconcile).toHaveBeenCalledWith(7, MEETING_ID);
    });

    it('needs only the organization and the meeting', async () => {
      await expect(
        handler.handle({ organizationId: 7, meetingId: MEETING_ID }, ctx),
      ).resolves.toBeUndefined();
    });

    it('refuses a message with no meeting id, without reconciling anything', async () => {
      const { meetingId, ...withoutId } = rawEvent;
      void meetingId;

      const err = await handler.handle(withoutId, ctx).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ZodError);
      expect(isRetryable(err)).toBe(false);
      expect(lock.acquire).not.toHaveBeenCalled();
      expect(sync.reconcile).not.toHaveBeenCalled();
    });

    it.each([
      ['a meeting id that is not a uuid', { meetingId: 'meeting-1' }],
      ['an organization that is not a positive integer', { organizationId: 0 }],
      ['an intent nobody sends', { intent: 'delete' }],
    ])('refuses %s', async (_label, bad) => {
      await expect(
        handler.handle({ ...rawEvent, ...bad }, ctx),
      ).rejects.toBeInstanceOf(ZodError);
    });
  });

  it('is busy — and retryable, without touching Google — while another delivery holds the lock', async () => {
    lock.acquire.mockResolvedValue(null);

    const err = await handler.handle(rawEvent, ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MeetingSyncRetry);
    expect((err as MeetingSyncRetry).reason).toBe('busy');
    expect(isRetryable(err)).toBe(true);
    expect(sync.reconcile).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('releases the lock when the reconcile throws, and lets the error through', async () => {
    const outage = Object.assign(
      new Error('Google Calendar is unavailable right now.'),
      {
        retryable: true,
      },
    );
    sync.reconcile.mockRejectedValue(outage);

    await expect(handler.handle(rawEvent, ctx)).rejects.toBe(outage);
    expect(lock.release).toHaveBeenCalledWith(MEETING_ID, 'lock-token');
  });

  it.each([
    [new MeetingSyncRetry('link_pending'), OUTCOME.link_pending],
    [
      new Error('Google Calendar refused the request (HTTP 400).'),
      OUTCOME.failed,
    ],
  ])('logs what a thrown attempt came to (%s)', async (err, outcome) => {
    sync.reconcile.mockRejectedValue(err);

    await handler.handle(rawEvent, ctx).catch(() => undefined);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, outcome }),
      expect.any(String),
    );
  });

  it('never logs the guest or anything else the payload carries', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await handler.handle(rawEvent, ctx);
    sync.reconcile.mockRejectedValue(new Error('down'));
    await handler.handle(rawEvent, ctx).catch(() => undefined);

    const logged = JSON.stringify([log.mock.calls, warn.mock.calls]);
    for (const secret of [
      GUEST,
      'Somchai',
      'Venue walkthrough',
      'floor plan',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
