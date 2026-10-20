import { Injectable, Logger } from '@nestjs/common';
import {
  type CalendarEventInput,
  type CalendarEventResult,
  CalendarProvider,
  CalendarSyncError,
} from './calendar.provider';

/** What eventa-api's fake OAuth adapter mints, and so all this one accepts. */
const FAKE_REFRESH_PREFIX = 'fake-refresh-';
const FAKE_ACCESS_TOKEN = 'fake-access-token';
/** Put this in a meeting's title to see the outage path without an outage. */
const OUTAGE_MARKER = '[calendar-down]';
/** HTTP statuses the fake pretends Google answered with. */
const REVOKED_STATUS = 400;
const OUTAGE_STATUS = 503;

const MEET_BASE = 'https://meet.google.com/';
/** Meet codes are ten letters, shown as xxx-xxxx-xxx. */
const MEET_CODE_LENGTH = 10;
const HEX_RADIX = 16;
const LETTER_A = 'a'.charCodeAt(0);

/**
 * A Meet-shaped link derived from the event id: each of the first ten hex
 * digits (0–f) becomes a letter a–p. Stable per event, so a re-sync of the same
 * meeting shows the same link — as Google's does.
 */
export function fakeMeetLink(eventId: string): string {
  const letters = [...eventId.slice(0, MEET_CODE_LENGTH)]
    .map((digit) => String.fromCharCode(LETTER_A + parseInt(digit, HEX_RADIX)))
    .join('');
  return `${MEET_BASE}${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
}

/**
 * The dev box's calendar (CALENDAR_PROVIDER=fake; refused in production by the
 * env schema). The whole sync path runs — refresh, upsert, Meet link, cancel —
 * with no Google account and no network, and eventa-api's fake OAuth adapter
 * hands out exactly the refresh tokens this one accepts.
 *
 * A title containing `[calendar-down]` fails as an outage, so "couldn't be
 * sent" and "Send it now" can be walked through by hand.
 *
 * It logs the operation and the event id, and nothing about the meeting.
 */
@Injectable()
export class FakeCalendarProvider extends CalendarProvider {
  readonly enabled = true;
  private readonly logger = new Logger('CalendarProvider');

  accessToken(refreshToken: string): Promise<string> {
    if (!refreshToken.startsWith(FAKE_REFRESH_PREFIX)) {
      return Promise.reject(
        new CalendarSyncError('auth_revoked', REVOKED_STATUS),
      );
    }
    return Promise.resolve(FAKE_ACCESS_TOKEN);
  }

  upsertEvent(
    _accessToken: string,
    input: CalendarEventInput,
  ): Promise<CalendarEventResult> {
    if (input.summary.includes(OUTAGE_MARKER)) {
      return Promise.reject(
        new CalendarSyncError('unavailable', OUTAGE_STATUS),
      );
    }
    this.logger.log(`Fake calendar upsert ${input.eventId}`);
    return Promise.resolve({
      eventId: input.eventId,
      meetLink: input.meet === 'remove' ? null : fakeMeetLink(input.eventId),
      meetPending: false,
    });
  }

  cancelEvent(_accessToken: string, eventId: string): Promise<void> {
    this.logger.log(`Fake calendar cancel ${eventId}`);
    return Promise.resolve();
  }
}
