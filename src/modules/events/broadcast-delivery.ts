import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { SentLedger } from '../../common/idempotency/idempotency.service';
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
 * Exactly-once per recipient: when a `ledger` is passed, a recipient already recorded
 * as sent is skipped (counted as delivered, not re-sent) and each successful send is
 * recorded **after** it lands. So a re-processed broadcast — whether from a broker
 * redelivery after an interrupted run or a DLQ replay after a partial failure —
 * delivers only the un-sent tail, once. Recipients are keyed by email (the confirmed
 * set is already distinct by email). Without a ledger, delivery is dedup-free.
 */
export async function deliverToEach(
  email: EmailProvider,
  recipients: readonly Recipient[],
  build: (recipient: Recipient) => EmailMessage,
  ledger?: SentLedger,
): Promise<DeliveryResult> {
  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    if (ledger && (await ledger.wasSent(recipient.email))) {
      sent += 1; // already delivered by an earlier run — don't re-send
      continue;
    }
    try {
      await email.send(build(recipient));
      await ledger?.markSent(recipient.email);
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}
