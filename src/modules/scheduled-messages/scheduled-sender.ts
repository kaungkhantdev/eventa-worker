import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { fill, pickWording } from '../../common/messaging/merge-fields';
import { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import type { Locale } from '../../db/schema/events';
import { deliverToEach } from '../events/broadcast-delivery';
import { EventRecipientsRepository } from '../events/event-recipients.repository';
import {
  ScheduledMessagesRepository,
  type DueEvent,
} from './scheduled-messages.repository';

/** What a scheduled message says to one reader. */
export interface Composed {
  subject: string;
  text: string;
}

/**
 * The organizer's own subject and opening for this reader, already filled —
 * or null where they wrote none and Eventa's copy should be used.
 */
export interface OrganizerWording {
  subject: string | null;
  opening: string | null;
}

export type Compose = (input: {
  name: string;
  locale: Locale;
  wording: OrganizerWording;
}) => Composed;

/**
 * Sends one scheduled message to every confirmed attendee of one event.
 *
 * Shared by the reminder and the thank-you, because everything except WHAT
 * they say is the same: claim the run, read the attendees and their languages
 * and the organizer's wording ONCE for the batch, send through the ledger, and
 * mark the run done only if nobody was missed.
 *
 * The ledger is keyed on the event and the kind, not on a broker message: a
 * cron has no message id, and a resumed run has to know who it already reached.
 */
@Injectable()
export class ScheduledSender {
  private readonly logger = new Logger(ScheduledSender.name);

  constructor(
    private readonly runs: ScheduledMessagesRepository,
    private readonly recipients: EventRecipientsRepository,
    private readonly templates: MessageTemplatesRepository,
    private readonly email: EmailProvider,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Returns false when the organizer has switched this message off — and in
   * that case does NOT mark the run done, so switching it back on inside the
   * window still reaches people.
   */
  async send(
    event: DueEvent,
    kind: string,
    now: Date,
    fields: Record<string, string>,
    compose: Compose,
  ): Promise<boolean> {
    if (!(await this.templates.isActive(event.organizationId, kind))) {
      return false;
    }
    await this.runs.claim(event, kind, now);

    const recipients = await this.recipients.confirmedRecipients(
      event.organizationId,
      event.eventId,
    );
    const [own, fallback, wording] = await Promise.all([
      this.recipients.attendeeLocales(recipients.map((r) => r.email)),
      this.recipients.fallbackLocale(event.organizationId, event.eventId),
      this.templates.wordingFor(event.organizationId, kind),
    ]);

    const { sent, failed } = await deliverToEach(
      this.email,
      recipients,
      (r) => {
        const locale = own.get(r.email) ?? fallback;
        const chosen = pickWording(wording, locale);
        const filled = { ...fields, first_name: r.name };
        return {
          to: r.email,
          ...compose({
            name: r.name,
            locale,
            wording: {
              subject: chosen.subject && fill(chosen.subject, filled),
              opening: chosen.body && fill(chosen.body, filled),
            },
          }),
          delivery: {
            organizationId: event.organizationId,
            kind,
            recipientName: r.name,
            eventId: event.eventId,
          },
        };
      },
      this.idempotency.recipientLedger(`${kind}:${event.eventId}`),
    );

    this.logger.log(
      { kind, eventId: event.eventId, sent, failed },
      'Sent scheduled message',
    );
    // Marked done ONLY when nobody was missed; otherwise the next run resumes.
    if (failed === 0) await this.runs.complete(event, kind, now);
    return true;
  }
}
