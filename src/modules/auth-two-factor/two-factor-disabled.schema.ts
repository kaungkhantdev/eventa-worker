import { z } from 'zod';

/** Routing key for the "two-factor turned off" notice from eventa-api. */
export const IDENTITY_TWO_FACTOR_DISABLED = 'identity.two_factor_disabled';

/** Tolerant reader — unknown fields are stripped; `version` allows overlap. */
export const twoFactorDisabledSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  userId: z.string().min(1),
  name: z.string(),
  email: z.string().min(1),
  occurredAt: z.string(), // ISO-8601
});

export type TwoFactorDisabledEvent = z.infer<typeof twoFactorDisabledSchema>;
