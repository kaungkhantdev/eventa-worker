/** Routing key eventa-api also publishes when an organizer offers a seat. */
export const WAITLIST_OFFERED = 'waitlist.offered';
/** Written only here, when the expiry sweep closes an offer nobody paid for. */
export const WAITLIST_OFFER_EXPIRED = 'waitlist.offer_expired';

/** The order page the offer is paid on — eventa-api's `ticketsUrlFor`. */
const ORDER_PATH = '/my/tickets/orders';

/** One row for the transactional outbox, as eventa-api's `OutboxEventInput`. */
export interface OutboxEvent {
  organizationId: number;
  aggregateType: 'order';
  aggregateId: string;
  routingKey: string;
  payload: Record<string, unknown>;
}

/** Who a waitlist email is about. */
export interface WaitlistEntryRef {
  organizationId: number;
  orderId: string;
  reference: string;
  eventId: string;
  buyerEmail: string;
  buyerName: string;
}

export interface WaitlistOfferedInput extends WaitlistEntryRef {
  ticketTypeName: string;
  ticketCount: number;
  totalSatang: number;
  currency: string;
  offerExpiresAt: Date;
  payUrl: string;
  occurredAt: Date;
}

/**
 * The offer, in EXACTLY the shape eventa-api's `waitlistOfferedEvent` writes:
 * an organizer's offer and one this sweep passed on reach the same handler,
 * and that handler cannot tell them apart. Keep the two in step.
 */
export function waitlistOfferedEvent(input: WaitlistOfferedInput): OutboxEvent {
  return {
    organizationId: input.organizationId,
    aggregateType: 'order',
    aggregateId: input.orderId,
    routingKey: WAITLIST_OFFERED,
    payload: {
      version: 1,
      ...ref(input),
      ticketTypeName: input.ticketTypeName,
      ticketCount: input.ticketCount,
      totalSatang: input.totalSatang,
      currency: input.currency,
      offerExpiresAt: input.offerExpiresAt.toISOString(),
      payUrl: input.payUrl,
      occurredAt: input.occurredAt.toISOString(),
    },
  };
}

/** "The attendee is told their offer expired" (US-REG-04). */
export function offerExpiredEvent(
  input: WaitlistEntryRef & { occurredAt: Date },
): OutboxEvent {
  return {
    organizationId: input.organizationId,
    aggregateType: 'order',
    aggregateId: input.orderId,
    routingKey: WAITLIST_OFFER_EXPIRED,
    payload: {
      version: 1,
      ...ref(input),
      occurredAt: input.occurredAt.toISOString(),
    },
  };
}

/** Absolute, because a root-relative link is dead in a mail client. */
export function payUrlFor(publicWebUrl: string, orderId: string): string {
  return `${publicWebUrl.replace(/\/+$/, '')}${ORDER_PATH}/${orderId}`;
}

function ref(input: WaitlistEntryRef): WaitlistEntryRef {
  return {
    organizationId: input.organizationId,
    orderId: input.orderId,
    reference: input.reference,
    eventId: input.eventId,
    buyerEmail: input.buyerEmail,
    buyerName: input.buyerName,
  };
}
