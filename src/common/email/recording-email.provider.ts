import { Logger } from '@nestjs/common';
import type { Clock } from '../time/clock';
import type { MessageDeliveriesRepository } from '../messaging/message-deliveries.repository';
import { EmailProvider, type EmailMessage } from './email.provider';

/**
 * Writes the delivery log (US-MSG-06) around whatever transport actually sends.
 *
 * A decorator rather than a call in each handler, for one reason: there are
 * nine places in this service that send mail, and "remember to log it" is a
 * rule nobody can enforce. Here there is a single write site, and it cannot be
 * forgotten by the tenth.
 *
 * Two failure rules, and they point opposite ways on purpose:
 *
 * - A send that fails is recorded AND rethrown. Swallowing it would turn a
 *   bounce into a silent success and stop the message ever being retried.
 * - A LOG write that fails is swallowed. The email has already gone; throwing
 *   would dead-letter a delivered message and send it to somebody twice. A
 *   missing row in a log is a smaller harm than a duplicate in an inbox.
 *
 * Messages with no `delivery` context are not logged at all — password resets
 * and verification codes are account mail, not the organizer's message log, and
 * filing them under a workspace would show somebody's personal mail to
 * colleagues who have no business reading it.
 */
export class RecordingEmailProvider extends EmailProvider {
  private readonly logger = new Logger(RecordingEmailProvider.name);

  constructor(
    private readonly inner: EmailProvider,
    private readonly deliveries: MessageDeliveriesRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.inner.send(message);
    } catch (cause) {
      await this.record(message, 'failed', reasonOf(cause));
      throw cause;
    }
    await this.record(message, 'sent', null);
  }

  private async record(
    message: EmailMessage,
    status: 'sent' | 'failed',
    error: string | null,
  ): Promise<void> {
    const context = message.delivery;
    if (!context) return;
    try {
      await this.deliveries.record({
        organizationId: context.organizationId,
        kind: context.kind,
        recipientEmail: message.to,
        recipientName: context.recipientName ?? null,
        eventId: context.eventId ?? null,
        status,
        error,
        sentAt: this.clock.now(),
      });
    } catch (cause) {
      this.logger.warn(
        { kind: context.kind, status, reason: reasonOf(cause) },
        'Could not record a delivery — the message itself was not affected',
      );
    }
  }
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
