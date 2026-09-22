import { z } from 'zod';

/** Routing key published by eventa-api when an order is placed and paid. */
export const REGISTRATION_CONFIRMED = 'registration.confirmed';

/**
 * Tolerant reader: only the fields this handler actually uses are required, so
 * a producer that adds one does not dead-letter real traffic. Note what is NOT
 * here — the QR tokens. They are bearer credentials and are read from the
 * database at render time, never carried on the bus.
 */
export const registrationConfirmedSchema = z
  .object({
    version: z.number().optional(),
    organizationId: z.number(),
    orderId: z.string(),
    reference: z.string(),
    eventId: z.string(),
    buyerEmail: z.string(),
    buyerName: z.string(),
    /**
     * Whatever the buyer typed, UNNORMALISED (US-DISC-06 AC5). Nullish rather
     * than required: most registrations carry no number, and producers older
     * than the field omit it entirely. `toThaiMobileE164` decides whether
     * there is a mobile here worth texting.
     */
    buyerPhone: z.string().nullish(),
    ticketCount: z.number(),
    totalSatang: z.number(),
    vatSatang: z.number().optional(),
    currency: z.string().optional(),
    isOnline: z.boolean().optional(),
    /** ABSOLUTE link built by the API from PUBLIC_WEB_URL; required — the
     * worker has no web origin of its own to fall back on. */
    ticketsUrl: z.string(),
    paid: z.boolean().optional(),
    occurredAt: z.string().optional(),
  })
  .passthrough();

export type RegistrationConfirmedEvent = z.infer<
  typeof registrationConfirmedSchema
>;
