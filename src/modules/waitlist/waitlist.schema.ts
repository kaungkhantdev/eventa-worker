import { z } from 'zod';
import { WAITLIST_OFFERED, WAITLIST_OFFER_EXPIRED } from './waitlist-events';

export { WAITLIST_OFFERED, WAITLIST_OFFER_EXPIRED };

/**
 * Tolerant readers for the two waitlist messages (US-REG-04): only what the
 * handlers use is required, so a producer that adds a field does not
 * dead-letter real traffic. `waitlist.offered` comes from eventa-api (an
 * organizer's offer) AND from this worker's expiry sweep (a lapsed offer passed
 * on) — both write the same shape.
 */
const entry = {
  version: z.number().optional(),
  organizationId: z.number(),
  orderId: z.string(),
  reference: z.string(),
  eventId: z.string(),
  buyerEmail: z.string(),
  buyerName: z.string(),
  occurredAt: z.string().optional(),
};

export const waitlistOfferedSchema = z
  .object({
    ...entry,
    ticketTypeName: z.string(),
    ticketCount: z.number(),
    totalSatang: z.number(),
    currency: z.string(),
    offerExpiresAt: z.string(),
    /** ABSOLUTE link to the order page the offer is paid on. */
    payUrl: z.string(),
  })
  .passthrough();

export const offerExpiredSchema = z.object(entry).passthrough();

export type WaitlistOfferedEvent = z.infer<typeof waitlistOfferedSchema>;
export type OfferExpiredEvent = z.infer<typeof offerExpiredSchema>;
