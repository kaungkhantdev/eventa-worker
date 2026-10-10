import { greeting } from '../../common/messaging/greeting';
import { inlineText } from '../../common/messaging/inline-text';
import type { Locale } from '../../db/schema/events';
import { formatMoney } from '../registration/confirmation-email';

/**
 * The emailed receipt for a paid registration, in English and Thai (US-SET-10:
 * "the attendee receives a receipt with VAT 7% itemized").
 *
 * It reproduces the LEDGER, it never recomputes it: every amount is the one
 * checkout wrote to the order, so this email and the receipt the attendee can
 * download from their payment history (eventa-api `receipt.svg.ts`) cannot
 * disagree about what somebody paid.
 *
 * Only the opening is the organizer's to reword. The seller, the lines, the
 * VAT and the total are what makes it a receipt, so they are always Eventa's.
 */

/** Receipts are dated in Thailand, whatever the reader's own clock says. */
const RECEIPT_TIMEZONE = 'Asia/Bangkok';
const PERCENT = 100;
const BCP47: Record<Locale, string> = { en: 'en-GB', th: 'th-TH' };

export interface ReceiptLine {
  name: string;
  quantity: number;
  unitSatang: number;
  lineSatang: number;
}

/** Who issued it — the organizer, as their workspace profile names them. */
export interface ReceiptSeller {
  name: string;
  address: string | null;
  taxId: string | null;
}

export interface PaymentReceipt {
  locale: Locale;
  buyerName: string;
  eventName: string;
  /** The order reference, which is the receipt number until invoicing mints its own. */
  number: string;
  paidAt: Date;
  /** The stored payment method, e.g. `Card`, `PromptPay`. */
  method: string;
  seller: ReceiptSeller;
  lines: readonly ReceiptLine[];
  subtotalSatang: number;
  discountSatang: number;
  serviceFeeSatang: number;
  totalSatang: number;
  /** The VAT embedded in the total, as recorded at purchase. */
  vatSatang: number;
  vatRate: number;
  currency: string;
  subject?: string | null;
  opening?: string | null;
}

interface Copy {
  subject: (event: string) => string;
  thanks: (event: string) => string;
  number: string;
  paidOn: string;
  method: string;
  billedTo: string;
  issuedBy: string;
  taxId: string;
  discount: string;
  serviceFee: string;
  total: string;
  net: string;
  vat: (percent: string) => string;
  vatIncluded: string;
  methods: Record<string, string>;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: (event) => `Your receipt for ${event}`,
    thanks: (event) =>
      `Thank you for your payment. Here is your receipt for ${event}.`,
    number: 'Receipt no.',
    paidOn: 'Date paid',
    method: 'Paid by',
    billedTo: 'Billed to',
    issuedBy: 'Issued by',
    taxId: 'Tax ID',
    discount: 'Discount',
    serviceFee: 'Service fee',
    total: 'Total paid',
    net: 'Amount excluding VAT',
    vat: (percent) => `VAT ${percent}% (included)`,
    vatIncluded: 'Prices include VAT. All amounts are in Thai Baht.',
    methods: {},
  },
  th: {
    subject: (event) => `ใบเสร็จรับเงิน: ${event}`,
    thanks: (event) =>
      `ขอบคุณสำหรับการชำระเงิน นี่คือใบเสร็จรับเงินสำหรับ ${event}`,
    number: 'เลขที่ใบเสร็จ',
    paidOn: 'วันที่ชำระเงิน',
    method: 'ชำระโดย',
    billedTo: 'ชื่อผู้ชำระเงิน',
    issuedBy: 'ออกโดย',
    taxId: 'เลขประจำตัวผู้เสียภาษี',
    discount: 'ส่วนลด',
    serviceFee: 'ค่าธรรมเนียมบริการ',
    total: 'ยอดชำระทั้งหมด',
    net: 'มูลค่าก่อนภาษีมูลค่าเพิ่ม',
    vat: (percent) => `ภาษีมูลค่าเพิ่ม ${percent}% (รวมในราคาแล้ว)`,
    vatIncluded: 'ราคารวมภาษีมูลค่าเพิ่มแล้ว จำนวนเงินทั้งหมดเป็นเงินบาท',
    // Brand names stay as they are; only the generic ones translate.
    methods: { Card: 'บัตรเครดิต/เดบิต', 'Bank transfer': 'โอนเงินผ่านธนาคาร' },
  },
};

/**
 * The fee checkout added. The order stores subtotal, discount and total but
 * not the fee, and checkout prices every order so that
 * `subtotal − discount + fee = total` — so this is exact, not an estimate.
 */
export function serviceFeeOf(order: {
  subtotalSatang: number;
  discountSatang: number;
  totalSatang: number;
}): number {
  return order.totalSatang - (order.subtotalSatang - order.discountSatang);
}

export function receiptSubject(receipt: PaymentReceipt): string {
  return inlineText(
    receipt.subject || COPY[receipt.locale].subject(receipt.eventName),
  );
}

export function receiptBody(receipt: PaymentReceipt): string {
  const t = COPY[receipt.locale];
  const opening = receipt.opening
    ? [receipt.opening]
    : [
        greeting(receipt.locale, receipt.buyerName),
        '',
        t.thanks(receipt.eventName),
      ];
  return [
    ...opening,
    '',
    `${t.number}: ${receipt.number}`,
    `${t.paidOn}: ${formatPaidOn(receipt.paidAt, receipt.locale)}`,
    `${t.method}: ${t.methods[receipt.method] ?? receipt.method}`,
    `${t.billedTo}: ${inlineText(receipt.buyerName)}`,
    '',
    ...sellerLines(receipt.seller, t),
    '',
    ...receipt.lines.map((line) => lineText(line, receipt)),
    ...amountLines(receipt, t),
    ...vatLines(receipt, t),
  ].join('\n');
}

function sellerLines(seller: ReceiptSeller, t: Copy): string[] {
  return [
    `${t.issuedBy}: ${inlineText(seller.name)}`,
    // The address is NOT flattened: a postal address is legitimately several
    // lines, and flattening it would mangle every honest one. The name and
    // the tax id are single values and stay on their line.
    ...(seller.address ? [seller.address] : []),
    ...(seller.taxId ? [`${t.taxId}: ${inlineText(seller.taxId)}`] : []),
  ];
}

function lineText(line: ReceiptLine, receipt: PaymentReceipt): string {
  const money = (satang: number) => moneyOf(satang, receipt);
  return `${inlineText(line.name)} × ${line.quantity} @ ${money(line.unitSatang)}: ${money(line.lineSatang)}`;
}

/** A discount or fee of nothing is left out: "Discount: ฿0.00" reads as a failure. */
function amountLines(receipt: PaymentReceipt, t: Copy): string[] {
  return [
    ...(receipt.discountSatang > 0
      ? [`${t.discount}: −${moneyOf(receipt.discountSatang, receipt)}`]
      : []),
    ...(receipt.serviceFeeSatang > 0
      ? [`${t.serviceFee}: ${moneyOf(receipt.serviceFeeSatang, receipt)}`]
      : []),
    `${t.total}: ${moneyOf(receipt.totalSatang, receipt)}`,
  ];
}

/**
 * Only when the order carried VAT. A workspace that charges none must not be
 * handed a document saying it did.
 */
function vatLines(receipt: PaymentReceipt, t: Copy): string[] {
  if (receipt.vatSatang <= 0) return [];
  return [
    `${t.net}: ${moneyOf(receipt.totalSatang - receipt.vatSatang, receipt)}`,
    `${t.vat(percentOf(receipt.vatRate))}: ${moneyOf(receipt.vatSatang, receipt)}`,
    '',
    t.vatIncluded,
  ];
}

function moneyOf(satang: number, receipt: PaymentReceipt): string {
  return formatMoney(satang, receipt.currency, receipt.locale);
}

/** 0.07 → "7"; a fractional rate keeps its decimals rather than rounding away. */
function percentOf(rate: number): string {
  return String(Number((rate * PERCENT).toFixed(2)));
}

function formatPaidOn(paidAt: Date, locale: Locale): string {
  return paidAt.toLocaleDateString(BCP47[locale], {
    timeZone: RECEIPT_TIMEZONE,
    dateStyle: 'long',
  });
}
