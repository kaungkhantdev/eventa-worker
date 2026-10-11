import { z } from 'zod';

/**
 * Routing key for a session that moved on a schedule people are following
 * (US-PROG-03). Mirrors eventa-api's `SESSION_CHANGED`.
 */
export const PROGRAM_SESSION_CHANGED = 'program.session_changed';

/**
 * A field an organizer may simply not have filled in. Blank is normalised to
 * null at the edge: `Where:  → Hall B` is a personalization field left
 * unfilled, and the notice has one sentence for "not announced yet".
 */
const optionalText = z
  .string()
  .nullable()
  .default(null)
  .transform((value) => (value?.trim() ? value : null));

/**
 * Where and when a session sat. `day` is the event DAY NUMBER, not a date, and
 * the times are naive wall clocks on the event's own calendar — see
 * `session-sitting.ts`. Deliberately not bounded (`day >= 1`, a time regex):
 * a schema that refuses a message eventa-api considers valid dead-letters real
 * traffic, and the one value that cannot be rendered is caught where it is
 * rendered instead.
 */
const sittingSchema = z.object({
  day: z.number().int(),
  startTime: z.string().min(1),
  endTime: optionalText,
  room: optionalText,
});

/** Tolerant reader — unknown fields are stripped; `version` allows overlap. */
export const sessionChangedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().min(1),
  previous: sittingSchema,
  current: sittingSchema,
  /**
   * Optional, and never read — which is exactly why it must not be required.
   *
   * A tolerant reader's job is to reject only what it cannot work without. This
   * handler never looks at `occurredAt`: the notice says where the session was
   * and where it is now, both of which travel on `previous`/`current`. Required,
   * a producer that stopped sending it would fail `schema.parse`, ride the retry
   * ladder and dead-letter the message — no mail, over a field that could not
   * have changed the mail. Its two sibling schemas say `.optional()` for this
   * reason (`registration-rejected`'s `occurredAt`, `invitation-sent`'s
   * `sentAt`); this was the odd one out.
   */
  occurredAt: z.string().optional(), // ISO-8601
});

export type SessionChangedEvent = z.infer<typeof sessionChangedSchema>;
