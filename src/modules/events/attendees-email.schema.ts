import { z } from 'zod';

/** Routing key for an organizer's "Email all attendees" broadcast (US-EVT-14). */
export const EVENTS_ATTENDEES_EMAIL_REQUESTED =
  'events.attendees_email_requested';

/**
 * Tolerant reader. The payload deliberately carries no recipient addresses — the
 * worker resolves the confirmed attendees at send time (no PII on the bus).
 * `recipientCount` is only the informational count captured when requested.
 */
export const attendeesEmailRequestedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  eventId: z.string().min(1),
  subject: z.string().min(1),
  message: z.string().min(1),
  requestedByUserId: z.string().min(1),
  recipientCount: z.number().int().nonnegative().default(0),
  occurredAt: z.string(), // ISO-8601
});

export type AttendeesEmailRequestedEvent = z.infer<
  typeof attendeesEmailRequestedSchema
>;
