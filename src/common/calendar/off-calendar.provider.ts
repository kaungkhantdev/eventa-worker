import { Injectable } from '@nestjs/common';
import { CalendarProvider } from './calendar.provider';

const NOT_CONFIGURED = 'Google Calendar is not configured on this worker';

/**
 * No calendar at all — what a worker gets with no Google client configured.
 *
 * `enabled: false` is the part that matters: the meeting sync asks first and
 * records the meeting "not connected" without calling anything. Unlike
 * `OffSmsProvider`, a call made anyway THROWS rather than resolving, because a
 * calendar call that silently did nothing would be recorded as "synced" — an
 * invite the guest never got.
 */
@Injectable()
export class OffCalendarProvider extends CalendarProvider {
  readonly enabled = false;

  accessToken(): Promise<string> {
    return Promise.reject(new Error(NOT_CONFIGURED));
  }

  upsertEvent(): Promise<never> {
    return Promise.reject(new Error(NOT_CONFIGURED));
  }

  cancelEvent(): Promise<void> {
    return Promise.reject(new Error(NOT_CONFIGURED));
  }
}
