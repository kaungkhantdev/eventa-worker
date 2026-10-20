import { z } from 'zod';
import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import { localeEnum } from '../../db/schema/events';

/**
 * Tolerant reader — unknown fields are stripped; `version` allows overlap.
 *
 * `claimUrl` carries the claim token in the clear, the way
 * `identity.password_reset_requested` carries `resetUrl`: whoever holds it can
 * create the account and choose its password. It and `email` must never reach
 * a log.
 *
 * `locale` is the one field allowed to be missing or wrong, and `.catch` is the
 * point. It chooses which language the mail is written in and nothing else, so
 * a producer that drops it — or names a language this service has no copy for
 * — costs the reader their language, never the only link that can create the
 * account. Every other field is required: each one is printed or addressed.
 *
 * `organizationId` is the PLATFORM organization's, where every attendee account
 * lives; it is required because every identity event carries one, not because
 * this mail is scoped by it.
 */
export const bookingAccountLinkRequestedSchema = z.object({
  version: z.number().int().default(1),
  organizationId: z.number().int(),
  orderId: z.string().min(1),
  /** The buyer's name off the order. May be blank; the mail then greets nobody. */
  name: z.string(),
  /** The buyer's address — where the proof goes. Never logged. */
  email: z.string().min(1),
  eventName: z.string().min(1),
  /** `<PUBLIC_WEB_URL>/portal/register?claim=<token>`. Never logged. */
  claimUrl: z.string().min(1),
  /** When the token stops working. ISO-8601 UTC. */
  expiresAt: z.string(),
  locale: z.enum(localeEnum.enumValues).catch(DEFAULT_LOCALE),
  occurredAt: z.string(), // ISO-8601 UTC
});

export type BookingAccountLinkRequestedEvent = z.infer<
  typeof bookingAccountLinkRequestedSchema
>;
