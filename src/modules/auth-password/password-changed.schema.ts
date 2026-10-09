import { z } from 'zod';

/** Routing key for the "your password was changed" notice from eventa-api. */
export const IDENTITY_PASSWORD_CHANGED = 'identity.password_changed';

/**
 * Tolerant reader — unknown fields are stripped; `version` allows overlap.
 *
 * `userId` is a uuid on the wire and is checked only for being non-empty, like
 * every other identity schema here. Format-checking it would buy nothing — the
 * handler passes it to a lookup and a log line, never parses it — and would
 * turn an upstream change of id shape into a dead-lettered security notice.
 *
 * `otherSessionsSignedOut` is the one field that may go missing, and the
 * `.catch` is the point rather than an afterthought. It buys ONE SENTENCE of
 * the notice; the change, its timestamp and the advice are all still true
 * without it. So a producer that stops sending it — or sends something that
 * cannot be a count at all — must cost the reader that sentence and not the
 * message, exactly as a failed language read costs them Thai and not the
 * message (`common/db/refinement-read.ts`). Anything unusable becomes
 * `undefined`, and `password-changed.notice.ts` then drops the line.
 *
 * It is deliberately NOT `.default(0)`, which is what the sibling
 * `attendeesEmailRequestedSchema.recipientCount` does: there the count is
 * informational and zero is a harmless stand-in, while here `0` is a REAL
 * answer — the account had nothing else signed in — and must not double as
 * "unknown". Defaulting would have the notice assert, to somebody who may be
 * reading about an intruder, that nothing else was signed in when this service
 * does not know that.
 */
export const passwordChangedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  userId: z.string().min(1),
  name: z.string(),
  email: z.string().min(1),
  otherSessionsSignedOut: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .catch(undefined),
  occurredAt: z.string(), // ISO-8601
});

export type PasswordChangedEvent = z.infer<typeof passwordChangedSchema>;
