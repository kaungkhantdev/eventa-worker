import { z } from 'zod';

/** Routing key eventa-api publishes when an organizer invites someone. */
export const INVITATION_SENT = 'invitation.sent';

/**
 * Tolerant reader for `invitation.sent` (US-REG-06). Only the fields this
 * handler actually uses are required, so a producer that adds one does not
 * dead-letter real traffic.
 *
 * Note what is NOT required, and why:
 *
 * - **`organizationId`** — eventa-api does not send it. Every other event in
 *   this service carries the tenant on the payload; `inviteSentEvent` puts it
 *   on the outbox ROW only, and the relay publishes the payload alone. The
 *   handler therefore resolves the workspace from the event id instead (see
 *   {@link InvitationsRepository.invitedEvent}), which it has to read anyway.
 * - **`invitationId`** — it is built as `${eventId}:${recipientEmail}`, so it
 *   is not an id this service may log. Declaring it would invite exactly that.
 *   It is also the wrong idempotency key: it is stable for the pair forever,
 *   while a re-invitation after eventa-api's 24-hour suppression window is a
 *   NEW outbox row that must actually send. The message id is the key.
 * - **`eventName`** — captured when the invite was written. The handler reads
 *   the event's current name, so a renamed event is not invited to under its
 *   old name.
 */
export const invitationSentSchema = z
  .object({
    version: z.number().optional(),
    eventId: z.string(),
    recipientName: z.string(),
    recipientEmail: z.string(),
    /** The organizer's personal note, shown above the body. Null when none. */
    message: z.string().nullish(),
    /**
     * ABSOLUTE link into the event's public registration flow, built by the
     * API from `PUBLIC_WEB_URL` — the worker has no web origin of its own.
     * Required: an invitation with no way to register is not an invitation.
     */
    registerUrl: z.string(),
    sentAt: z.string().optional(),
  })
  .passthrough();

export type InvitationSentEvent = z.infer<typeof invitationSentSchema>;
