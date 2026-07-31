import { z } from 'zod';

/** Routing key for the sign-in event emitted by eventa-api's outbox. */
export const IDENTITY_SIGNED_IN = 'identity.signed_in';

/**
 * The shape this consumer expects. Tolerant reader — unknown fields are stripped,
 * not rejected; `version` allows producer/consumer overlap across changes.
 */
export const signedInSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  userId: z.string().min(1),
  device: z.string(),
  ip: z.string().nullable().optional(),
  occurredAt: z.string(), // ISO-8601
});

export type SignedInEvent = z.infer<typeof signedInSchema>;
