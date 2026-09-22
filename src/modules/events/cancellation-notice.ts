import type { Locale } from '../../db/schema/events';

/**
 * The cancellation notice, in English and Thai (US-EVT-08).
 *
 * It used to be English only, which meant a Thai attendee was told their event
 * was off in a language they might not read — and an organizer's Thai wording
 * for it (US-MSG-02) was saved and then never sent to anybody.
 *
 * The REFUND line is always last and always Eventa's, in both languages.
 * Somebody whose event was cancelled needs to know their money is coming back,
 * and that is not a sentence to leave to whoever was editing a template.
 */

export interface CancellationNotice {
  attendeeName: string;
  eventName: string;
  /** The organizer's reason. Empty when they gave none. */
  reason: string;
  locale: Locale;
  /** The organizer's subject, already filled. Null or absent: use Eventa's. */
  subject?: string | null;
  /** The organizer's opening, already filled. Null or absent: use Eventa's. */
  opening?: string | null;
}

interface Copy {
  subject: (event: string) => string;
  greeting: (name: string) => string;
  cancelled: (event: string) => string;
  reason: (reason: string) => string;
  refund: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: (event) => `Cancelled: ${event}`,
    greeting: (name) => `Hi ${name},`,
    cancelled: (event) =>
      `We're sorry to let you know that "${event}" has been cancelled.`,
    reason: (reason) => `Reason: ${reason}`,
    refund:
      'If you purchased a ticket, our team will process your refund to the original payment method.',
  },
  th: {
    subject: (event) => `ยกเลิกแล้ว: ${event}`,
    greeting: (name) => `สวัสดีคุณ ${name}`,
    cancelled: (event) => `ขออภัยที่ต้องแจ้งว่า "${event}" ได้ถูกยกเลิกแล้ว`,
    reason: (reason) => `เหตุผล: ${reason}`,
    refund:
      'หากคุณซื้อบัตรไว้ ทีมงานจะดำเนินการคืนเงินไปยังช่องทางการชำระเงินเดิมของคุณ',
  },
};

export function cancellationSubject(notice: CancellationNotice): string {
  return notice.subject || COPY[notice.locale].subject(notice.eventName);
}

export function cancellationBody(notice: CancellationNotice): string {
  const t = COPY[notice.locale];
  const opening = notice.opening
    ? [notice.opening]
    : [
        t.greeting(notice.attendeeName),
        '',
        t.cancelled(notice.eventName),
        // Omitted rather than printed empty: "Reason: " with nothing after it
        // is a personalization field left unfilled.
        ...(notice.reason ? ['', t.reason(notice.reason)] : []),
      ];
  return [...opening, '', t.refund].join('\n');
}
