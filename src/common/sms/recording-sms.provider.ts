import { Logger } from '@nestjs/common';
import { dbReason } from '../db/db-error';
import type { MessageDeliveriesRepository } from '../messaging/message-deliveries.repository';
import type { Clock } from '../time/clock';
import { SmsProvider, type SmsMessage } from './sms.provider';

/**
 * Writes the delivery log (US-MSG-06) around whatever transport actually texts
 * — the SMS twin of `RecordingEmailProvider`, and deliberately the same shape
 * so the two cannot drift into logging by different rules.
 *
 * The two failure rules point opposite ways, for the same reasons as email,
 * and one of them harder: a text that has gone out has already been PAID for,
 * so throwing over a failed log write would dead-letter it and buy a second
 * one.
 *
 * What the row does NOT contain is the number. `recipient_email` is NOT NULL
 * and there is no phone column, so a text is filed under the person's address;
 * the number reaches the provider and nowhere else.
 */
export class RecordingSmsProvider extends SmsProvider {
  private readonly logger = new Logger(RecordingSmsProvider.name);

  constructor(
    private readonly inner: SmsProvider,
    private readonly deliveries: MessageDeliveriesRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  /** Whether the deployment can text at all is the transport's to say. */
  get enabled(): boolean {
    return this.inner.enabled;
  }

  async send(message: SmsMessage): Promise<void> {
    try {
      await this.inner.send(message);
    } catch (cause) {
      await this.record(message, 'failed', reasonOf(cause));
      throw cause;
    }
    await this.record(message, 'sent', null);
  }

  private async record(
    message: SmsMessage,
    status: 'sent' | 'failed',
    error: string | null,
  ): Promise<void> {
    const context = message.delivery;
    if (!context) return;
    try {
      await this.deliveries.record({
        organizationId: context.organizationId,
        channel: 'sms',
        kind: context.kind,
        recipientEmail: context.recipientEmail,
        recipientName: context.recipientName ?? null,
        eventId: context.eventId ?? null,
        status,
        error,
        sentAt: this.clock.now(),
      });
    } catch (cause) {
      this.logger.warn(
        { kind: context.kind, status, db: dbReason(cause) },
        'Could not record a text — the text itself was not affected',
      );
    }
  }
}

/**
 * Why a send failed, for the organizer to read on their own delivery row.
 *
 * The transport's own words on purpose — a carrier's rejection is the answer
 * to "why did my text not arrive", and this row is already scoped to the one
 * workspace whose message it was. The LOG gets {@link dbReason} instead.
 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
