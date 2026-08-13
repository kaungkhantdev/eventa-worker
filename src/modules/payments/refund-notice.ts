import type { Locale } from '../../db/schema/events';
import { formatMoney } from '../registration/confirmation-email';

/** Why the money came back, in words a human reads. */
const REASONS: Record<string, string> = {
  duplicate_payment: 'the order was paid for twice',
  seats_unavailable: 'the seats were taken while the payment was in flight',
  soldout: 'the tier sold out while the payment was in flight',
};

/** Anything the API adds later still reads as a sentence, never as a code. */
export function describeReason(reason: string | undefined): string {
  if (!reason) return 'the registration could not be completed';
  return REASONS[reason] ?? reason.replace(/_/g, ' ');
}

export interface RefundNotice {
  reference: string;
  eventName: string;
  amountSatang: number;
  currency: string;
  reason: string | undefined;
  locale: Locale;
}

/**
 * The organizer's alert. Deliberately an ACTION item, not an FYI: the money has
 * already left the buyer's account, and `refunds.issued_by` requires a real
 * user — so nothing moves until a person issues it (US-FIN-02).
 */
export function organizerSubject(notice: RefundNotice): string {
  return `Action needed: refund owed on ${notice.reference}`;
}

export function organizerBody(notice: RefundNotice): string {
  const amount = formatMoney(notice.amountSatang, notice.currency, 'en');
  return [
    `A payment of ${amount} needs refunding for ${notice.eventName}.`,
    '',
    `Booking reference: ${notice.reference}`,
    `Amount: ${amount}`,
    `Reason: ${describeReason(notice.reason)}.`,
    '',
    'The registration was cancelled and the buyer has been told their money is',
    'coming back. Issue the refund from Finance → Payments to complete it.',
  ].join('\n');
}

const BUYER_COPY = {
  en: {
    subject: (event: string) => `Your payment for ${event} is being refunded`,
    body: (reference: string, amount: string, reason: string) =>
      [
        'We were not able to complete your registration, so your payment is',
        'being refunded in full.',
        '',
        `Booking reference: ${reference}`,
        `Amount: ${amount}`,
        `What happened: ${reason}.`,
        '',
        'Refunds usually reach your account within a few working days. You do',
        'not need to do anything.',
      ].join('\n'),
  },
  th: {
    subject: (event: string) => `กำลังคืนเงินค่าบัตร ${event} ให้คุณ`,
    body: (reference: string, amount: string, reason: string) =>
      [
        'เราไม่สามารถดำเนินการลงทะเบียนของคุณให้สมบูรณ์ได้ จึงกำลังคืนเงินเต็มจำนวน',
        '',
        `รหัสการจอง: ${reference}`,
        `จำนวนเงิน: ${amount}`,
        `สาเหตุ: ${reason}`,
        '',
        'โดยปกติเงินจะเข้าบัญชีของคุณภายในไม่กี่วันทำการ คุณไม่ต้องดำเนินการใด ๆ เพิ่มเติม',
      ].join('\n'),
  },
} as const;

export function buyerSubject(notice: RefundNotice): string {
  return BUYER_COPY[notice.locale].subject(notice.eventName);
}

export function buyerBody(notice: RefundNotice): string {
  return BUYER_COPY[notice.locale].body(
    notice.reference,
    formatMoney(notice.amountSatang, notice.currency, notice.locale),
    describeReason(notice.reason),
  );
}
