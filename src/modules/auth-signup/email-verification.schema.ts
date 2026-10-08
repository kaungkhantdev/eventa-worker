import { z } from 'zod';

/** Routing key for the sign-up confirmation email, emitted by eventa-api's outbox. */
export const IDENTITY_EMAIL_VERIFICATION_REQUESTED =
  'identity.email_verification_requested';

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
