import { Injectable, Logger } from '@nestjs/common';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import {
  MeetingCalendarSyncService,
  type SyncOutcome,
} from './meeting-calendar-sync.service';
import {
  type MeetingSyncRequestedEvent,
  meetingSyncRequestedSchema,
} from './meeting-sync-requested.schema';
import { MeetingSyncRetry } from './meeting-sync.errors';
import { MeetingSyncLock } from './meeting-sync.lock';
import {
  MEETING_SYNC_REQUESTED,
  OUTCOME,
} from '../../common/constants/meetings.constants';

/**
 * Handles `meeting.sync_requested` (US-MTG-04..08): makes the meeting's Google
 * Calendar event match its row — the guest's invite with a Meet link and a
 * 15-minute reminder, the move, the cancellation — or records why it could not.
 *
 * Thin by design: validate, take the meeting's lock, delegate to
 * `MeetingCalendarSyncService`, log one line. Every decision is the service's.
 *
 * Failures are not handled here. The service has already written the outcome
 * onto the meeting; the error says on `retryable` whether another attempt can
 * help, and `rabbitmq/failure.ts` believes it — an outage rides the retry
 * ladder, a refusal parks in the dead-letter queue.
 *
 * Idempotency is the row's: a redelivered message finds the meeting `synced`
 * and calls nobody. The deterministic event id makes even a repeated call
 * harmless.
 *
 * NOTHING FROM THE PAYLOAD BUT IDS REACHES A LOG. It carries the guest's
 * address; the schema strips it before this code ever sees it.
 */
@Injectable()
export class MeetingSyncRequestedHandler extends ValidatedHandler<MeetingSyncRequestedEvent> {
  readonly routingKey = MEETING_SYNC_REQUESTED;
  protected readonly schema = meetingSyncRequestedSchema;
  private readonly logger = new Logger(MeetingSyncRequestedHandler.name);

  constructor(
    private readonly sync: MeetingCalendarSyncService,
    private readonly lock: MeetingSyncLock,
  ) {
    super();
  }

  protected async process(
    payload: MeetingSyncRequestedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const token = await this.lock.acquire(payload.meetingId);
    if (!token) throw new MeetingSyncRetry('busy');
    try {
      const outcome = await this.sync.reconcile(
        payload.organizationId,
        payload.meetingId,
      );
      this.record(payload, ctx, outcome);
    } catch (err) {
      this.record(payload, ctx, outcomeOf(err));
      throw err;
    } finally {
      await this.lock.release(payload.meetingId, token);
    }
  }

  private record(
    payload: MeetingSyncRequestedEvent,
    ctx: MessageContext,
    outcome: SyncOutcome,
  ): void {
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        messageId: ctx.messageId,
        organizationId: payload.organizationId,
        meetingId: payload.meetingId,
        intent: payload.intent,
        outcome,
      },
      'Meeting calendar sync',
    );
  }
}

/** What a thrown attempt came to, for the log line. */
function outcomeOf(err: unknown): SyncOutcome {
  return err instanceof MeetingSyncRetry && err.reason === 'link_pending'
    ? OUTCOME.link_pending
    : OUTCOME.failed;
}
