import { Injectable, Logger } from '@nestjs/common';
import {
  CALENDAR_EXPIRED_SENTENCE,
  type CalendarEventInput,
  CalendarProvider,
  CalendarSyncError,
  googleEventIdOf,
} from '../../common/calendar/calendar.provider';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import {
  CANCELLED_MEETING,
  CONNECTED_CALENDAR,
  EXPIRED_CALENDAR,
  SYNCED_MEETING,
  VIDEO_MEETING,
} from '../../db/schema';
import {
  CalendarConnectionsRepository,
  type ConnectionForSync,
} from './calendar-connections.repository';
import {
  MeetingSyncFailure,
  MeetingSyncRetry,
  UNREADABLE_CONNECTION_SENTENCE,
} from './meeting-sync.errors';
import {
  type MeetingForSync,
  MeetingsRepository,
  type SyncOutcomePatch,
} from './meetings.repository';

/** How one delivery ended — logged, never shown to anybody. */
export const OUTCOME = {
  /** The meeting no longer exists, or was deleted. Nothing to do. */
  gone: 'gone',
  /** A redelivery, or a message a newer one already settled. */
  already_synced: 'already_synced',
  not_connected: 'not_connected',
  /** Google refused the grant; the connection is now marked expired. */
  connection_expired: 'connection_expired',
  synced: 'synced',
  /** The organizer changed the meeting mid-sync; the newer message owns it. */
  superseded: 'superseded',
  failed: 'failed',
  /** Google has not minted the Meet link yet; the message comes back. */
  link_pending: 'link_pending',
} as const;

export type SyncOutcome = (typeof OUTCOME)[keyof typeof OUTCOME];

const SYNCED: SyncOutcomePatch = { syncStatus: 'synced', syncError: null };

/** Seconds are not part of a meeting time; the calendar gets ':00'. */
const HH_MM = 5;

/**
 * Makes one meeting's Google Calendar event match its row (US-MTG-04..08):
 * the guest's invite, the Meet link, the reminder, the reschedule, the
 * cancellation — and the "not connected" / "expired" states in between.
 *
 * **It always works from the CURRENT row**, never from the message. Messages
 * can arrive late, twice, or out of order (prefetch, several replicas, the
 * retry ladder); the row cannot be stale. Each outcome is then written back
 * conditional on the row's `updated_at` being the one read, so an organizer
 * edit made mid-sync wins and the newer message it enqueued finishes the job.
 *
 * The event id is deterministic (`googleEventIdOf`), so a retry, a cancel
 * that overtook its create, or a resync after a reconnect all name the same
 * event — none can leave a second invite behind.
 *
 * Logs ids only, and only here and in the handler. The guest, the title, the
 * notes, the location, the link and both tokens never reach a log line.
 */
@Injectable()
export class MeetingCalendarSyncService {
  private readonly logger = new Logger(MeetingCalendarSyncService.name);

  constructor(
    private readonly meetings: MeetingsRepository,
    private readonly connections: CalendarConnectionsRepository,
    private readonly calendar: CalendarProvider,
    private readonly cipher: SecretCipher,
  ) {}

  async reconcile(
    organizationId: number,
    meetingId: string,
  ): Promise<SyncOutcome> {
    const row = await this.meetings.findForSync(organizationId, meetingId);
    if (!row || row.deletedAt) return OUTCOME.gone;
    if (row.syncStatus === SYNCED_MEETING) return OUTCOME.already_synced;

    const connection = await this.connections.find(organizationId);
    const seenCipher = this.usableCipher(connection);
    if (!seenCipher) return this.withoutConnection(row, connection);
    return this.syncWith(row, seenCipher);
  }

  /** The token to sync with, or null when there is nothing usable to sync to. */
  private usableCipher(connection: ConnectionForSync | null): Buffer | null {
    if (!this.calendar.enabled) return null;
    if (connection?.status !== CONNECTED_CALENDAR) return null;
    return connection.refreshTokenCipher;
  }

  /**
   * No usable calendar (US-MTG-08 AC2): the meeting is kept and flagged. A
   * cancellation nobody was ever invited to is simply done — nothing
   * reachable holds an invite to withdraw.
   */
  private withoutConnection(
    row: MeetingForSync,
    connection: ConnectionForSync | null,
  ): Promise<SyncOutcome> {
    if (row.status === CANCELLED_MEETING && !row.externalEventId) {
      return this.settle(row, SYNCED, OUTCOME.synced);
    }
    const expired = connection?.status === EXPIRED_CALENDAR;
    return this.settle(
      row,
      {
        syncStatus: 'not_connected',
        syncError: expired ? CALENDAR_EXPIRED_SENTENCE : null,
      },
      OUTCOME.not_connected,
    );
  }

  private async syncWith(
    row: MeetingForSync,
    seenCipher: Buffer,
  ): Promise<SyncOutcome> {
    const refreshToken = await this.readToken(row, seenCipher);
    try {
      const accessToken = await this.calendar.accessToken(refreshToken);
      return row.status === CANCELLED_MEETING
        ? await this.cancel(row, accessToken)
        : await this.upsert(row, accessToken);
    } catch (err) {
      if (err instanceof CalendarSyncError)
        return this.onCalendarFailure(row, seenCipher, err);
      throw err;
    }
  }

  /**
   * A token that will not decrypt will never decrypt: record it on the card
   * and park the message where an operator sees it. Almost always a worker
   * whose SECRET_ENCRYPTION_KEY is not eventa-api's.
   */
  private async readToken(
    row: MeetingForSync,
    seenCipher: Buffer,
  ): Promise<string> {
    try {
      return this.cipher.decrypt(seenCipher);
    } catch {
      await this.settle(
        row,
        { syncStatus: 'failed', syncError: UNREADABLE_CONNECTION_SENTENCE },
        OUTCOME.failed,
      );
      throw new MeetingSyncFailure(
        `${UNREADABLE_CONNECTION_SENTENCE} Check that SECRET_ENCRYPTION_KEY is eventa-api's.`,
      );
    }
  }

  /** US-MTG-06: withdraw the invite, with the reason, under whatever id it has. */
  private async cancel(
    row: MeetingForSync,
    accessToken: string,
  ): Promise<SyncOutcome> {
    await this.calendar.cancelEvent(
      accessToken,
      row.externalEventId ?? googleEventIdOf(row.id),
      cancelNoteOf(row),
    );
    return this.settle(row, SYNCED, OUTCOME.synced);
  }

  /**
   * US-MTG-04/05/07: invite, move, or change the mode of the meeting. The
   * event id is recorded before the outcome, and whatever the outcome write
   * finds — see `MeetingsRepository.recordExternalId`.
   */
  private async upsert(
    row: MeetingForSync,
    accessToken: string,
  ): Promise<SyncOutcome> {
    const result = await this.calendar.upsertEvent(
      accessToken,
      eventInputOf(row),
      !!row.externalEventId,
    );
    await this.meetings.recordExternalId(
      row.organizationId,
      row.id,
      result.eventId,
    );
    const video = row.mode === VIDEO_MEETING;
    const link = video ? (result.meetLink ?? row.link) : null;
    // Still pending: the next attempt sends the same conference request, and
    // Google answers with the same conference — the link, once it exists.
    if (video && !link) throw new MeetingSyncRetry('link_pending');
    return this.settle(row, { ...SYNCED, link }, OUTCOME.synced);
  }

  /**
   * A revoked grant is acked (only a reconnect helps — US-MTG-08 AC3); an
   * outage or a refusal is recorded on the card and rethrown so the consumer
   * retries or parks it — unless a newer change already owns the meeting.
   */
  private async onCalendarFailure(
    row: MeetingForSync,
    seenCipher: Buffer,
    err: CalendarSyncError,
  ): Promise<SyncOutcome> {
    if (err.failure === 'auth_revoked') return this.expire(row, seenCipher);
    const outcome = await this.settle(
      row,
      { syncStatus: 'failed', syncError: err.message },
      OUTCOME.failed,
    );
    if (outcome === OUTCOME.superseded) return outcome;
    throw err;
  }

  private async expire(
    row: MeetingForSync,
    seenCipher: Buffer,
  ): Promise<SyncOutcome> {
    await this.connections.markExpired(row.organizationId, seenCipher);
    this.logger.warn(
      { organizationId: row.organizationId, meetingId: row.id },
      'Google stopped accepting the workspace calendar connection — marked it expired',
    );
    await this.settle(
      row,
      { syncStatus: 'not_connected', syncError: CALENDAR_EXPIRED_SENTENCE },
      OUTCOME.not_connected,
    );
    return OUTCOME.connection_expired;
  }

  /** Write the outcome if the row is still the one read; otherwise superseded. */
  private async settle(
    row: MeetingForSync,
    patch: SyncOutcomePatch,
    outcome: SyncOutcome,
  ): Promise<SyncOutcome> {
    const written = await this.meetings.writeOutcome(
      row.organizationId,
      row.id,
      row.updatedAt,
      patch,
    );
    return written ? outcome : OUTCOME.superseded;
  }
}

/** 'YYYY-MM-DD' + 'HH:MM:SS' → 'YYYY-MM-DDTHH:MM:00', Bangkok wall clock. */
const wallClock = (date: string, time: string): string =>
  `${date}T${time.slice(0, HH_MM)}:00`;

/**
 * Mint a link, keep the one already on the event, or take it away. A video
 * meeting keeps its link only when both the event and the link are recorded.
 */
function meetOf(row: MeetingForSync): CalendarEventInput['meet'] {
  if (row.mode !== VIDEO_MEETING) return 'remove';
  return row.externalEventId && row.link ? 'keep' : 'create';
}

function eventInputOf(row: MeetingForSync): CalendarEventInput {
  return {
    eventId: googleEventIdOf(row.id),
    summary: row.title,
    description: row.notes ?? '',
    location: row.location,
    startLocal: wallClock(row.meetingDate, row.startTime),
    endLocal: wallClock(row.meetingDate, row.endTime),
    guestEmail: row.guestEmail,
    guestName: row.person,
    meet: meetOf(row),
    // One request per meeting VERSION: a retry of the same version gets the
    // same conference back, and an edit asks afresh.
    conferenceRequestId: `${row.id}-v${row.version}`,
  };
}

/** The reason, then the notes, written onto the event before it is deleted. */
function cancelNoteOf(row: MeetingForSync): string | null {
  if (!row.cancellationReason) return null;
  const notes = row.notes ? `\n\n${row.notes}` : '';
  return `Cancelled: ${row.cancellationReason}${notes}`;
}
