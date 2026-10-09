import { z } from 'zod';

/** Routing key eventa-api publishes when an organizer turns a sign-up down. */
export const REGISTRATION_REJECTED = 'registration.rejected';

/**
 * Tolerant reader for `registration.rejected` (US-REG-02): only the fields the
 * handler uses are required, so a producer that adds one does not dead-letter
 * real traffic.
 *
 * Note what is NOT required and NOT used: the event name and the order's money
 * are absent from the payload and read from the database at send time, because
 * eventa-api commits the rejection BEFORE it attempts the refund — the message
 * cannot know which side of that it will be read on.
 */
export const registrationRejectedSchema = z
  .object({
    version: z.number().optional(),
    organizationId: z.number(),
    orderId: z.string(),
    reference: z.string(),
    eventId: z.string(),
    buyerEmail: z.string(),
    buyerName: z.string(),
    /**
     * The organizer's own note, or nothing. Declared so the contract is
     * visible, OPTIONAL so a producer that stops sending it cannot
     * dead-letter a rejection — and deliberately never read: the producer's
     * event says it is "shown to nobody but the organizer". See
     * `rejection-notice.ts` for why the notice is written without it.
     */
    reason: z.string().nullish(),
    occurredAt: z.string().optional(),
  })
  .passthrough();

export type RegistrationRejectedEvent = z.infer<
  typeof registrationRejectedSchema
>;
