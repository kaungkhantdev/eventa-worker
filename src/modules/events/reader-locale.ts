import type { Locale } from '../../db/schema/events';
import type { EventRecipientsRepository } from './event-recipients.repository';

/**
 * One reader's language for a message about one event: their own account's,
 * then the event's, then the workspace's, then English — the precedence every
 * attendee email uses, so nobody gets their ticket in Thai and the next
 * message about it in English.
 */
export async function readerLocale(
  recipients: Pick<
    EventRecipientsRepository,
    'attendeeLocales' | 'fallbackLocale'
  >,
  reader: { organizationId: number; eventId: string; email: string },
): Promise<Locale> {
  const own = await recipients.attendeeLocales([reader.email]);
  return (
    own.get(reader.email) ??
    recipients.fallbackLocale(reader.organizationId, reader.eventId)
  );
}
