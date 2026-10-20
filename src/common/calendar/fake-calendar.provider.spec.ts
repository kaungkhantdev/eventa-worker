import { Logger } from '@nestjs/common';
import {
  type CalendarEventInput,
  CalendarProvider,
  CalendarSyncError,
} from './calendar.provider';
import { FakeCalendarProvider, fakeMeetLink } from './fake-calendar.provider';

const EVENT_ID = '0123456789abcdef0123456789abcdef';

const input = (over: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  eventId: EVENT_ID,
  summary: 'Venue walkthrough',
  description: 'Bring the floor plan',
  location: null,
  startLocal: '2026-10-21T14:00:00',
  endLocal: '2026-10-21T15:00:00',
  guestEmail: 'somchai@example.test',
  guestName: 'Somchai Jaidee',
  meet: 'create',
  conferenceRequestId: 'req-v1',
  ...over,
});

/**
 * The dev box's calendar (CALENDAR_PROVIDER=fake): the whole sync runs —
 * token, upsert, Meet link, cancel — with no Google account, and a title can
 * ask for an outage so the failure path is reachable by hand.
 */
describe('FakeCalendarProvider', () => {
  // Typed as the port: the sync service only ever sees it that way.
  const fake: CalendarProvider = new FakeCalendarProvider();

  afterEach(() => jest.restoreAllMocks());

  it('is enabled', () => {
    expect(fake.enabled).toBe(true);
  });

  describe('accessToken', () => {
    it('trades a refresh token the fake OAuth adapter minted', async () => {
      await expect(fake.accessToken('fake-refresh-1234')).resolves.toBe(
        'fake-access-token',
      );
    });

    it('treats any other refresh token as a revoked grant', async () => {
      const refused = fake.accessToken('1//real-google-token');
      await expect(refused).rejects.toBeInstanceOf(CalendarSyncError);
      await expect(refused).rejects.toMatchObject({
        failure: 'auth_revoked',
        status: 400,
        retryable: false,
      });
    });
  });

  describe('upsertEvent', () => {
    it('answers with the event id it was given and a Meet link', async () => {
      await expect(
        fake.upsertEvent('fake-access-token', input(), false),
      ).resolves.toEqual({
        eventId: EVENT_ID,
        meetLink: 'https://meet.google.com/abc-defg-hij',
        meetPending: false,
      });
    });

    it('keeps a link when asked to keep one', async () => {
      const result = await fake.upsertEvent(
        'fake-access-token',
        input({ meet: 'keep' }),
        true,
      );
      expect(result.meetLink).toBe(fakeMeetLink(EVENT_ID));
    });

    it('gives no link to a meeting that is no longer a video call', async () => {
      const result = await fake.upsertEvent(
        'fake-access-token',
        input({ meet: 'remove' }),
        true,
      );
      expect(result.meetLink).toBeNull();
    });

    it('fails as an outage when the title asks for one', async () => {
      const down = fake.upsertEvent(
        'fake-access-token',
        input({ summary: 'Sponsor sync [calendar-down]' }),
        false,
      );
      await expect(down).rejects.toMatchObject({
        failure: 'unavailable',
        status: 503,
        retryable: true,
      });
    });
  });

  it('withdraws an invite without complaint', async () => {
    await expect(
      fake.cancelEvent('fake-access-token', EVENT_ID, 'Cancelled: closed'),
    ).resolves.toBeUndefined();
  });

  it('logs the operation and the event id — nothing about the meeting', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    await fake.upsertEvent('fake-access-token', input(), false);
    await fake.cancelEvent('fake-access-token', EVENT_ID, 'Cancelled: closed');

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain(`Fake calendar upsert ${EVENT_ID}`);
    expect(logged).toContain(`Fake calendar cancel ${EVENT_ID}`);
    for (const secret of [
      'somchai@example.test',
      'Somchai',
      'Venue walkthrough',
      'floor plan',
      'closed',
      'fake-access-token',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('fakeMeetLink', () => {
  it('maps the first ten hex digits onto a–p in Meet’s xxx-xxxx-xxx shape', () => {
    expect(fakeMeetLink('0123456789abcdef')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(fakeMeetLink('abcdef0000ffff')).toBe(
      'https://meet.google.com/klm-nopa-aaa',
    );
  });

  it('is stable for one event, so a re-sync never changes the link', () => {
    expect(fakeMeetLink(EVENT_ID)).toBe(fakeMeetLink(EVENT_ID));
  });
});
