/** The waitlist module's named constants. */

/** Routing key eventa-api also publishes when an organizer offers a seat. */
export const WAITLIST_OFFERED = 'waitlist.offered';

/** Written only here, when the expiry sweep closes an offer nobody paid for. */
export const WAITLIST_OFFER_EXPIRED = 'waitlist.offer_expired';

/** The order page the offer is paid on — eventa-api's `ticketsUrlFor`. */
export const ORDER_PATH = '/my/tickets/orders';
