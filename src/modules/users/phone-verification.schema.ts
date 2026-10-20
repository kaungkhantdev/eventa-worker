import { z } from 'zod';

/**
 * Tolerant reader — unknown fields are stripped; `version` allows overlap.
 *
 * Only the fields the text needs are required. The producer also sends the
 * member's `name` and an `occurredAt`; neither is used, because a code text
 * greets nobody and says nothing about when it was asked for.
 *
 * `phone` is the REQUESTED number and `code` is the whole credential, both in
 * the clear — see eventa-api's `phone-verification-requested.event.ts`. Neither
 * may reach a log.
 */
export const phoneVerificationRequestedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  userId: z.string().min(1),
  /** E.164. The text goes here, never to the number in use today. */
  phone: z.string().min(1),
  code: z.string().min(1),
  /** When the code stops working. ISO-8601 UTC. */
  expiresAt: z.string(),
});

export type PhoneVerificationRequestedEvent = z.infer<
  typeof phoneVerificationRequestedSchema
>;
