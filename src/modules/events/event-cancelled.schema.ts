import { z } from 'zod';

/** Tolerant reader — unknown fields are stripped; `version` allows overlap. */
export const eventCancelledSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  eventId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  reason: z.string().default(''),
  cancelledBy: z.string().min(1),
  occurredAt: z.string(), // ISO-8601
});

export type EventCancelledEvent = z.infer<typeof eventCancelledSchema>;
