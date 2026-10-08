import { OFF_UNTIL_SWITCHED_ON_SLUGS } from '../../db/schema/messaging';

/**
 * Whether a message is on in a workspace whose organizer never touched it —
 * i.e. what an absent `message_templates` row means for this slug.
 *
 * One function rather than a `?? true` at each call site: the per-message send
 * and the scheduled sweep's SQL both need the answer, and two copies of it is
 * how one of them ends up mailing a workspace the other thinks is off.
 */
export function activeWhenUnset(slug: string): boolean {
  return !OFF_UNTIL_SWITCHED_ON_SLUGS.includes(slug);
}
