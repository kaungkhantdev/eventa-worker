import type { Locale } from '../../db/schema/events';
import { formatMoney } from './confirmation-email';

/**
 * The rejection notice, in English and Thai (US-REG-02): an organizer turned a
 * sign-up down, and the person who signed up is told so.
 *
 * TWO DECISIONS SHAPE THIS COPY.
 *
 * **The organizer's note is not in it.** `registration.rejected` carries
 * `reason` — free text an organizer typed into the reject dialog — and the
 * producer's own event says it travels "for the organizer's own audit trail"
 * and is "shown to nobody but the organizer". So there is no `reason` field on
 * {@link RejectionNotice} at all: a note reading "suspected duplicate card" or
 * "banned last year" is an internal annotation, and forwarding it to the person
 * it is about is a harm this module cannot undo. What replaces it is the
 * closing line, which is in EVERY rejection: who to contact, and the reference
 * to quote. That is what somebody refused with no explanation actually needs,
 * and it means the notice reads the same whether a note was left or not —
 * rather than a template with a hole where the reason goes.
 *
 * **The money line is always Eventa's, and always last.** "Rejected" and
 * "refunded" are different facts, and a buyer who paid while their
 * registration waited for a decision cares about both. The line is chosen from
 * the order as it stands when the message is sent ({@link moneyOf}), never from
 * the payload — eventa-api commits the rejection BEFORE it attempts the refund,
 * so the two can be read either side of it. Like the cancellation notice's
 * refund line, it is never replaced by an organizer's wording: what became of
 * somebody's money is not a sentence to leave to whoever last edited a
 * template.
 */

/**
 * What the rejection did to the attendee's money, in the only terms this
 * notice may state: already back, owed, never taken, or not spoken about.
 */
export type RejectionMoney =
  'refunded' | 'refund-coming' | 'nothing-taken' | 'none';

/** The slice of the order the money line is chosen from. */
export interface RejectionPayment {
  totalSatang: number;
  /**
   * `orders.payment_status`, typed `string` rather than the mirrored enum on
   * purpose: eventa-api owns that type, and a value added upstream arrives here
   * verbatim (see `common/messaging/locale.ts`). {@link moneyOf} treats one it
   * does not recognise as a payment state it may not describe.
   */
  paymentStatus: string;
}

/**
 * One reader's rejection notice. It carries the money DECISION rather than the
 * order's payment status: {@link moneyOf} is the one place that reads a raw
 * status, so the copy below cannot reach a second, differing conclusion from
 * the same row.
 */
export interface RejectionNotice {
  locale: Locale;
  attendeeName: string;
  eventName: string;
  /** What the organizer is asked about, and what the reader quotes back. */
  reference: string;
  money: RejectionMoney;
  /** Integer satang, formatted at the edge in the reader's language. */
  totalSatang: number;
  currency: string;
  /** The organizer's subject, already filled. Null or absent: use Eventa's. */
  subject?: string | null;
  /** The organizer's opening, already filled. Null or absent: use Eventa's. */
  opening?: string | null;
}

/** Money captured and still held by the platform — a refund is owed. */
const CAPTURED_PAYMENT_STATUS = 'paid';
/** The refund has landed, so the attendee can be told it has. */
const REFUNDED_PAYMENT_STATUS = 'refunded';
/** Nothing was ever captured: no money of theirs is anywhere. */
const UNCAPTURED_PAYMENT_STATUSES: readonly string[] = ['pending', 'failed'];

/**
 * Which money line this rejection earns.
 *
 * A free registration gets none — there was never anything to give back. An
 * unrecognised payment status gets none either: silence costs a reader nothing,
 * while "no payment was taken" to somebody who is out of pocket is a lie, and
 * "it will be refunded" is a promise this service cannot make for a state it
 * has never heard of.
 */
export function moneyOf(payment: RejectionPayment): RejectionMoney {
  if (payment.totalSatang === 0) return 'none';
  if (payment.paymentStatus === REFUNDED_PAYMENT_STATUS) return 'refunded';
  if (payment.paymentStatus === CAPTURED_PAYMENT_STATUS) return 'refund-coming';
  return UNCAPTURED_PAYMENT_STATUSES.includes(payment.paymentStatus)
    ? 'nothing-taken'
    : 'none';
}

/** One language's strings. Declared so EN and TH must stay the same shape. */
interface Copy {
  subject: (event: string) => string;
  greeting: (name: string) => string;
  rejected: (event: string) => string;
  reference: string;
  refunded: (amount: string) => string;
  refundComing: (amount: string) => string;
  nothingTaken: string;
  closing: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: (event) => `Your registration for ${event} was not approved`,
    greeting: (name) => `Hi ${name},`,
    rejected: (event) =>
      `We're sorry to let you know that your registration for "${event}" was not approved by the organizer, so your place has not been confirmed.`,
    reference: 'Booking reference',
    refunded: (amount) =>
      `Your payment of ${amount} has been refunded to the original payment method. Refunds can take a few days to appear on your statement.`,
    refundComing: (amount) =>
      `Your payment of ${amount} will be refunded to the original payment method. Refunds can take a few days to appear on your statement.`,
    nothingTaken: 'No payment was taken for this registration.',
    closing:
      'If you think this was a mistake, please contact the organizer and quote your booking reference.',
  },
  th: {
    subject: (event) => `การลงทะเบียนของคุณสำหรับ ${event} ไม่ได้รับการอนุมัติ`,
    greeting: (name) => `สวัสดีคุณ ${name}`,
    rejected: (event) =>
      `ขออภัยที่ต้องแจ้งว่าการลงทะเบียนของคุณสำหรับ "${event}" ไม่ได้รับการอนุมัติจากผู้จัดงาน ที่นั่งของคุณจึงไม่ได้รับการยืนยัน`,
    reference: 'รหัสการจอง',
    refunded: (amount) =>
      `เงินที่คุณชำระไว้จำนวน ${amount} ได้คืนไปยังช่องทางการชำระเงินเดิมของคุณแล้ว การคืนเงินอาจใช้เวลาสองสามวันจึงจะปรากฏในรายการเดินบัญชีของคุณ`,
    refundComing: (amount) =>
      `เงินที่คุณชำระไว้จำนวน ${amount} จะถูกคืนไปยังช่องทางการชำระเงินเดิมของคุณ การคืนเงินอาจใช้เวลาสองสามวันจึงจะปรากฏในรายการเดินบัญชีของคุณ`,
    nothingTaken: 'ไม่มีการเรียกเก็บเงินสำหรับการลงทะเบียนนี้',
    closing:
      'หากคุณคิดว่าเกิดความผิดพลาด กรุณาติดต่อผู้จัดงานและแจ้งรหัสการจองของคุณ',
  },
};

export function rejectionSubject(notice: RejectionNotice): string {
  return notice.subject || COPY[notice.locale].subject(notice.eventName);
}

/**
 * The rejection body, in the reader's language.
 *
 * An organizer's wording replaces the OPENING only (US-MSG-02). The reference,
 * the money and the line saying who to ask are Eventa's throughout — they are
 * the part a rejected attendee has to be able to act on.
 */
export function rejectionBody(notice: RejectionNotice): string {
  const t = COPY[notice.locale];
  return [
    ...(notice.opening
      ? [notice.opening]
      : [t.greeting(notice.attendeeName), '', t.rejected(notice.eventName)]),
    '',
    `${t.reference}: ${notice.reference}`,
    ...moneyLines(notice, t),
    '',
    t.closing,
  ].join('\n');
}

/**
 * Omitted entirely rather than rendered empty, exactly as the confirmation
 * omits a venue it does not have: a blank line about somebody's money reads as
 * a message that was supposed to say something and failed to.
 */
function moneyLines(notice: RejectionNotice, t: Copy): string[] {
  const line = moneyLine(notice, t);
  return line ? ['', line] : [];
}

function moneyLine(notice: RejectionNotice, t: Copy): string | null {
  const amount = (): string =>
    formatMoney(notice.totalSatang, notice.currency, notice.locale);
  switch (notice.money) {
    case 'refunded':
      return t.refunded(amount());
    case 'refund-coming':
      return t.refundComing(amount());
    case 'nothing-taken':
      return t.nothingTaken;
    case 'none':
      return null;
  }
}
