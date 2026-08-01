import { z } from 'zod';

/** Routing key for the "event published" notice, emitted by eventa-api's outbox. */
export const EVENTS_PUBLISHED = 'events.published';

/** Tolerant reader — unknown fields are stripped; `version` allows overlap. */
export const eventPublishedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  eventId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  publishedBy: z.string().min(1),
  occurredAt: z.string(), // ISO-8601
});

export type EventPublishedEvent = z.infer<typeof eventPublishedSchema>;
