import type { Locale } from '../../db/schema/events';

/** The registration module's named constants. */

/** Satang per baht — money crosses the bus as an integer and is formatted here. */
export const SATANG_PER_BAHT = 100;

/** BCP-47 tag per locale; `th-TH` also gives Thai numerals' grouping and era. */
export const BCP47: Record<Locale, string> = { en: 'en-GB', th: 'th-TH' };

/**
 * How much of an event's name a text will carry.
 *
 * Cost, not tidiness. A Thai text is UCS-2 at 70 characters per segment (67
 * once it splits), and an English one holds 160 only while every character is
 * GSM-7 — which an organizer's event name has no obligation to be. Bounding
 * the one field Eventa does not write bounds the bill.
 */
export const MAX_EVENT_NAME_CHARS = 40;

/** ASCII, deliberately: '…' is not GSM-7 and would double the cost. */
export const ELLIPSIS = '...';

export const DEFAULT_CURRENCY = 'THB';

/**
 * The three messages one confirmed order can owe, each recorded once it is
 * done — two emails and, for an attendee who gave a mobile, a text.
 */
export const CONFIRMATION_PART = 'confirmation';

export const RECEIPT_PART = 'receipt';

export const SMS_PART = 'sms';

/** Routing key published by eventa-api when an order is placed and paid. */
export const REGISTRATION_CONFIRMED = 'registration.confirmed';

/** Routing key eventa-api publishes when an organizer turns a sign-up down. */
export const REGISTRATION_REJECTED = 'registration.rejected';

/** Money captured and still held by the platform — a refund is owed. */
export const CAPTURED_PAYMENT_STATUS = 'paid';

/** The refund has landed, so the attendee can be told it has. */
export const REFUNDED_PAYMENT_STATUS = 'refunded';

/** Nothing was ever captured: no money of theirs is anywhere. */
export const UNCAPTURED_PAYMENT_STATUSES: readonly string[] = [
  'pending',
  'failed',
];
