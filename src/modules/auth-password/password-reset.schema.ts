import { z } from 'zod';

/** Routing key for the password-reset email, emitted by eventa-api's outbox. */
export const IDENTITY_PASSWORD_RESET_REQUESTED =
  'identity.password_reset_requested';

/** Tolerant reader — unknown fields are stripped; `version` allows overlap. */
export const passwordResetRequestedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  userId: z.string().min(1),
  name: z.string(),
  email: z.string().min(1),
  resetUrl: z.string().min(1),
  occurredAt: z.string(), // ISO-8601
});

export type PasswordResetRequestedEvent = z.infer<
  typeof passwordResetRequestedSchema
>;
