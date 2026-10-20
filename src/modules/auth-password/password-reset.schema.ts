import { z } from 'zod';

/** Tolerant reader — unknown fields are stripped; `version` allows overlap. */
export const passwordResetRequestedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  userId: z.string().min(1),
  name: z.string(),
  email: z.string().min(1),
  /**
   * The workspace the link resets, for an organizer. Optional: an attendee's
   * event carries none, and an older producer sent none at all.
   */
  workspaceName: z.string().min(1).optional(),
  resetUrl: z.string().min(1),
  occurredAt: z.string(), // ISO-8601
});

export type PasswordResetRequestedEvent = z.infer<
  typeof passwordResetRequestedSchema
>;
