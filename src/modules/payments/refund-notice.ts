import { inlineText } from '../../common/messaging/inline-text';
import type { Locale } from '../../db/schema/events';
import { formatMoney } from '../registration/confirmation-email';
import {
  COULD_NOT_COMPLETE,
  REASONS,
} from '../../common/constants/payments.constants';

/**
 * A code the API adds later still reads as words, never as a code: English
 * turns its underscores into spaces; Thai says plainly that the registration
 * could not be completed, rather than print English inside a Thai email. A
 * trailing full stop is dropped, so a sentence-shaped reason from an older
 * API does not end in two.
 */
export function describeReason(
  reason: string | undefined,
  locale: Locale,
): string {
  if (!reason) return COULD_NOT_COMPLETE[locale];
  const known = REASONS[reason];
  if (known) return known[locale];
  if (locale === 'th') return COULD_NOT_COMPLETE.th;
  return reason.replace(/_/g, ' ').replace(/\.+$/, '');
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
  return inlineText(`Action needed: refund owed on ${notice.reference}`);
}

export function organizerBody(notice: RefundNotice): string {
  const amount = formatMoney(notice.amountSatang, notice.currency, 'en');
  return [
    `A payment of ${amount} needs refunding for ${inlineText(notice.eventName)}.`,
    '',
    `Booking reference: ${notice.reference}`,
    `Amount: ${amount}`,
    `Reason: ${inlineText(describeReason(notice.reason, 'en'))}.`,
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
  return inlineText(BUYER_COPY[notice.locale].subject(notice.eventName));
}

export function buyerBody(notice: RefundNotice): string {
  return BUYER_COPY[notice.locale].body(
    notice.reference,
    formatMoney(notice.amountSatang, notice.currency, notice.locale),
    // Flattened like the organizer's copy of the same value: `describeReason`
    // passes an UNRECOGNISED code straight through, so this is free text and
    // not the closed set the parameter name suggests.
    inlineText(describeReason(notice.reason, notice.locale)),
  );
}
