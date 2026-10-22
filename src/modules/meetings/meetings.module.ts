import { Module } from '@nestjs/common';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { CalendarConnectionsRepository } from './calendar-connections.repository';
import { MeetingCalendarSyncService } from './meeting-calendar-sync.service';
import { MeetingSyncRequestedHandler } from './meeting-sync-requested.handler';
import { MeetingSyncLock } from './meeting-sync.lock';
import { MeetingsRepository } from './meetings.repository';

/**
 * Coordination meetings' calendar side (E12, US-MTG-04..08; mirrors
 * eventa-api's `meetings` context): consumes `meeting.sync_requested` and
 * makes each meeting's Google Calendar event match its row — the guest's
 * invite, the Meet link, the 15-minute reminder, the reschedule and the
 * cancellation — through the CalendarProvider port.
 *
 * It writes back onto two eventa-api tables (ADR-15): `meetings.sync_status`,
 * `sync_error` and `link` conditional on `updated_at`, `external_event_id`
 * unconditionally; and `calendar_connections.status` → 'expired' when Google
 * refuses the grant, conditional on the token it used.
 *
 * The handler is not registered with RabbitmqModule — `ConsumerService`
 * discovers it through `DiscoveryService` and binds its routing key. The
 * CalendarProvider port comes from the global CalendarModule, Redis (for the
 * per-meeting lock) from the global IdempotencyModule and the Drizzle client
 * from the global DatabaseModule, so this module imports none of them.
 * SecretCipher is provided here: this is the only module that decrypts.
 */
@Module({
  providers: [
    MeetingSyncRequestedHandler,
    MeetingCalendarSyncService,
    MeetingSyncLock,
    MeetingsRepository,
    CalendarConnectionsRepository,
    SecretCipher,
  ],
})
export class MeetingsModule {}
