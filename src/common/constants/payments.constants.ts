import type { Locale } from '../../db/schema/events';

/** The payments module's named constants. */

/** Receipts are dated in Thailand, whatever the reader's own clock says. */
export const RECEIPT_TIMEZONE = 'Asia/Bangkok';

export const PERCENT = 100;

export const BCP47: Record<Locale, string> = { en: 'en-GB', th: 'th-TH' };

/** eventa-api's column default; a row always has one, this is belt and braces. */
export const DEFAULT_VAT_RATE = 0.07;

/**
 * Why the money came back, in the reader's language, for every reason CODE
 * eventa-api sends on `payment.refund_required` (its `REFUND_REASON`, plus
 * `duplicate_payment`). Keep the two lists in step: a code missing here
 * reaches a Thai buyer as English words. No closing full stop — the bodies
 * add their own.
 */
export const REASONS: Record<string, Record<Locale, string>> = {
  duplicate_payment: {
    en: 'the order was paid for twice',
    th: 'มีการชำระเงินสำหรับคำสั่งซื้อนี้ซ้ำสองครั้ง',
  },
  seats_unavailable: {
    en: 'the seats were taken while the payment was in flight',
    th: 'ที่นั่งถูกผู้อื่นจองไปแล้วระหว่างที่กำลังชำระเงิน',
  },
  soldout: {
    en: 'the tier sold out while the payment was in flight',
    th: 'บัตรประเภทนี้ขายหมดระหว่างที่กำลังชำระเงิน',
  },
  seats_released: {
    en: 'the seats were released before the payment arrived',
    th: 'ที่นั่งถูกปล่อยคืนก่อนที่การชำระเงินจะเสร็จสมบูรณ์',
  },
  seat_mismatch: {
    en: 'the seat reservation no longer matched the order',
    th: 'การจองที่นั่งไม่ตรงกับคำสั่งซื้ออีกต่อไป',
  },
  tier_removed: {
    en: 'the ticket type was no longer on sale when the payment arrived',
    th: 'บัตรประเภทนี้ไม่มีจำหน่ายแล้วเมื่อการชำระเงินเสร็จสมบูรณ์',
  },
  order_closed: {
    en: 'the order had already closed when the payment arrived',
    th: 'คำสั่งซื้อนี้ปิดไปแล้วก่อนที่การชำระเงินจะเสร็จสมบูรณ์',
  },
};

/** No reason given, or one only English words could describe to a Thai reader. */
export const COULD_NOT_COMPLETE: Record<Locale, string> = {
  en: 'the registration could not be completed',
  th: 'ไม่สามารถดำเนินการลงทะเบียนให้สมบูรณ์ได้',
};

export const DEFAULT_CURRENCY = 'THB';

/** Routing key for money that arrived for inventory we could not honour. */
export const PAYMENT_REFUND_REQUIRED = 'payment.refund_required';
