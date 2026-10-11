import { z } from 'zod';

/** Routing key for a teammate's join link, emitted by eventa-api's outbox. */
export const IDENTITY_MEMBER_INVITED = 'identity.member_invited';

/** Tolerant reader — unknown fields are stripped; `version` allows overlap. */
export const memberInvitedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  userId: z.string().min(1),
  /** Typed by the inviting Admin about somebody else; see the handler. */
  name: z.string(),
  email: z.string().min(1),
  organizationName: z.string(),
  /** Absolute link that sets a password and activates — already holds the token. */
  acceptUrl: z.string().min(1),
  occurredAt: z.string(), // ISO-8601
});

export type MemberInvitedEvent = z.infer<typeof memberInvitedSchema>;
