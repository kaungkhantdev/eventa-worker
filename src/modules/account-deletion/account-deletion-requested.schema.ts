import { z } from 'zod';

/** Routing key for the account-closure notice, emitted by eventa-api's outbox. */
export const IDENTITY_ACCOUNT_DELETION_REQUESTED =
  'identity.account_deletion_requested';

/**
 * Tolerant reader — unknown fields are stripped; `version` allows overlap.
 *
 * What this payload does NOT carry is what shapes the whole notice: there is no
 * grace window and no cancellation token. eventa-api stamps `deleted_at` and
 * revokes every session in the SAME transaction that writes this event, so by
 * the time the message reaches us the account is already closed and there is
 * nothing left to cancel. The copy therefore tells the person it is done,
 * rather than offering an undo that does not exist.
 *
 * `email` is carried on the event rather than read back from the row on
 * purpose: the row's copy is the one scheduled to be scrubbed, so the event is
 * the only durable record of where to send this.
 */
export const accountDeletionRequestedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  userId: z.string().min(1),
  name: z.string(),
  email: z.string().min(1),
  occurredAt: z.string(), // ISO-8601, UTC
});

export type AccountDeletionRequestedEvent = z.infer<
  typeof accountDeletionRequestedSchema
>;
