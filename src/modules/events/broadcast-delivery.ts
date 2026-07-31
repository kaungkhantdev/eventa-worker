import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { Recipient } from './event-recipients.repository';

export interface DeliveryResult {
  sent: number;
  failed: number;
}

/**
 * Sends one message per recipient, tolerating individual failures so a single bad
 * address never aborts the batch. Returns counts; the caller decides whether a
 * non-zero `failed` should dead-letter the message (nack → DLQ) for retry.
 *
 * KNOWN LIMITATION (at-least-once): delivery is idempotent only at the whole-message
 * level — the consumer dedups on the outbox messageId, not per recipient. So a DLQ
 * replay after a partial failure re-sends to already-notified recipients. A
 * per-(message, recipient) sent-ledger is the follow-up once a real (throwing) email
 * provider replaces the dev logger; until then the only provider (LogEmailProvider)
 * never throws, so `failed` is always 0 in practice.
 */
export async function deliverToEach(
  email: EmailProvider,
  recipients: readonly Recipient[],
  build: (recipient: Recipient) => EmailMessage,
): Promise<DeliveryResult> {
  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      await email.send(build(recipient));
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}
