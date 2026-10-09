import { z } from 'zod';

/** Routing key for the "confirm your new email" message, emitted by eventa-api. */
export const IDENTITY_EMAIL_CHANGE_REQUESTED =
  'identity.email_change_requested';

/**
 * Tolerant reader — unknown fields are stripped; `version` allows overlap.
 *
 * `email` is the REQUESTED address, not the one currently on the account. The
 * producer is explicit about this on its own field, and the distinction decides
 * who may receive the link: see {@link EmailChangeHandler}.
 *
 * The address the account signs in with today is NOT on the wire, and it does
 * not need to be: it is still the OLD address in this service's own `users`
 * view at the moment this event is handled, because eventa-api's
 * `requestEmailChange` writes only `pendingEmail` and `promoteEmail` does not
 * overwrite `email` until the link is opened. `UsersRepository.currentAddress`
 * reads it, and the handler warns it. Do not add a previous-address field here
 * to serve that warning — a copy on the wire would only be a second, stale
 * source for something the database already answers.
 */
export const emailChangeRequestedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  userId: z.string().min(1),
  name: z.string(),
  /** The requested address. The confirmation link goes here and nowhere else. */
  email: z.string().min(1),
  confirmUrl: z.string().min(1),
  occurredAt: z.string(), // ISO-8601
});

export type EmailChangeRequestedEvent = z.infer<
  typeof emailChangeRequestedSchema
>;
