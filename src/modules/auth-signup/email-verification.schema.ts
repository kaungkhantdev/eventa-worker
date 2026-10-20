import { z } from 'zod';

/** Tolerant reader — unknown fields are stripped; `version` allows overlap. */
export const emailVerificationRequestedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  userId: z.string().min(1),
  name: z.string(),
  email: z.string().min(1),
  verifyUrl: z.string().min(1),
  occurredAt: z.string(), // ISO-8601
});

export type EmailVerificationRequestedEvent = z.infer<
  typeof emailVerificationRequestedSchema
>;
