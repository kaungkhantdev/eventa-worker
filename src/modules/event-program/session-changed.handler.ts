import { Injectable, Logger } from '@nestjs/common';
import {
  type EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import { CANCELLED_EVENT_STATUS, type Locale } from '../../db/schema/events';
import { SESSION_CHANGE_SLUG } from '../../db/schema/messaging';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { deliverToEach } from '../events/broadcast-delivery';
import {
  EventRecipientsRepository,
  type Recipient,
} from '../events/event-recipients.repository';
import {
  EventProgramRepository,
  type EventContext,
} from './event-program.repository';
import {
  sessionChangeBody,
  sessionChangeSubject,
  type Change,
} from './session-change-notice';
import {
  PROGRAM_SESSION_CHANGED,
  type SessionChangedEvent,
  sessionChangedSchema,
} from './session-changed.schema';
import {
  sittingMoved,
  whenMoved,
  whenText,
  whereMoved,
} from './session-sitting';

/** The before→after "when", in each language, rendered once for the batch. */
type WhenByLocale = Record<Locale, Change<string>>;

/** Everything one announcement says, before it is addressed to anybody. */
interface Announcement {
  payload: SessionChangedEvent;
  event: EventContext;
  /** Null when the day and the times held and only the room moved. */
  when: WhenByLocale | null;
  /** Null when the room held. */
  room: Change<string | null> | null;
}

/**
 * Handles `program.session_changed` (US-PROG-03): an organizer moved a
 * session's day, time or room on an event people are following and chose to
 * announce it.
 *
 * Four things shape it:
 *
 * - **It is a FAN-OUT**, so exactly-once is per RECIPIENT, not per message.
 *   `recipientLedger` is consulted before each send and written after it, so a
 *   redelivery or a DLQ replay delivers only the un-sent tail: deduping on the
 *   message id alone would drop that tail, and claiming a recipient before the
 *   send would lose them outright.
 * - **The organizer can switch it off** (`message_templates.active`,
 *   US-MSG-01), and an absent row means on. This one is a courtesy rather than
 *   something an attendee is owed — the event still happens and the ticket
 *   still works — which is exactly why the switch has to be real.
 * - **Language follows the PERSON**: their own account's, then the event's,
 *   then the workspace's. Resolved from the database, because this goes to
 *   everybody at once and only the database knows each of them.
 * - **The payload carries no addresses**, so the recipients are resolved at
 *   send time: no PII on the bus and no stale list.
 *
 * **Who it reaches, and why it is a superset.** US-PROG-03 says "attendees who
 * added it to their schedule", but there is no per-session bookmark anywhere in
 * eventa-api's schema — `saved_events` bookmarks whole EVENTS and nothing
 * records a session. So this writes to the event's confirmed attendees, the
 * same set "Email all attendees" reaches. Narrowing it needs a `saved_sessions`
 * table, which is eventa-api's to add; until then the organizer asked for the
 * announcement and everybody holding a ticket gets it.
 *
 * **No organizer wording.** Every other gated message here honours US-MSG-02,
 * but eventa-api refuses `setWording` for a `planned` template and gives this
 * slug no merge-field tags, so there is nothing stored to read. When the
 * catalog entry becomes `controlled`, reading `wordingFor` for the opening —
 * never the before→after lines — is the change to make.
 */
@Injectable()
export class SessionChangedHandler extends ValidatedHandler<SessionChangedEvent> {
  readonly routingKey = PROGRAM_SESSION_CHANGED;
  protected readonly schema = sessionChangedSchema;
  private readonly logger = new Logger(SessionChangedHandler.name);

  constructor(
    private readonly events: EventProgramRepository,
    private readonly recipients: EventRecipientsRepository,
    private readonly templates: MessageTemplatesRepository,
    private readonly email: EmailProvider,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  protected async process(
    payload: SessionChangedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const event = await this.announceableOn(payload, ctx);
    if (event) await this.announce(this.compose(payload, event), ctx);
  }

  /**
   * The event this notice is about, or null when no notice should go out.
   *
   * Asked in increasing cost, and all of it BEFORE the recipients are read: a
   * message that will not be sent is no reason to pull a list of people's names
   * and addresses out of the database.
   */
  private async announceableOn(
    payload: SessionChangedEvent,
    ctx: MessageContext,
  ): Promise<EventContext | null> {
    if (!sittingMoved(payload.previous, payload.current)) {
      // Nothing to show for it. eventa-api only emits on a material change, so
      // this is a redelivery of an equal pair or a producer that has changed —
      // either way "a session changed" with no change in it tells nobody
      // anything.
      this.skip(payload, ctx, 'no move in the payload');
      return null;
    }
    if (
      !(await this.templates.isActive(
        payload.organizationId,
        SESSION_CHANGE_SLUG,
      ))
    ) {
      this.skip(payload, ctx, 'switched off for this workspace');
      return null;
    }
    const event = await this.events.eventContext(
      payload.organizationId,
      payload.eventId,
    );
    if (!event) {
      this.skip(payload, ctx, 'event is gone');
      return null;
    }
    if (event.status === CANCELLED_EVENT_STATUS) {
      // They have already been told the whole event is off; where its sessions
      // would have sat is no longer news.
      this.skip(payload, ctx, 'event is cancelled');
      return null;
    }
    return event;
  }

  /** What moved, rendered once per language rather than once per reader. */
  private compose(
    payload: SessionChangedEvent,
    event: EventContext,
  ): Announcement {
    const { previous, current } = payload;
    return {
      payload,
      event,
      when: whenMoved(previous, current)
        ? {
            en: this.whenChange(payload, event, 'en'),
            th: this.whenChange(payload, event, 'th'),
          }
        : null,
      room: whereMoved(previous, current)
        ? { before: previous.room, after: current.room }
        : null,
    };
  }

  private whenChange(
    payload: SessionChangedEvent,
    event: EventContext,
    locale: Locale,
  ): Change<string> {
    return {
      before: whenText(payload.previous, event, locale),
      after: whenText(payload.current, event, locale),
    };
  }

  private async announce(
    announcement: Announcement,
    ctx: MessageContext,
  ): Promise<void> {
    const { payload } = announcement;
    const recipients = await this.recipients.confirmedRecipients(
      payload.organizationId,
      payload.eventId,
    );
    // Everything a message needs, read ONCE for the batch — never a query per
    // recipient, which on a 2,000-person event is 2,000 round trips.
    const [own, fallback] = await Promise.all([
      this.recipients.attendeeLocales(recipients.map((r) => r.email)),
      this.recipients.fallbackLocale(payload.organizationId, payload.eventId),
    ]);
    const ledger = ctx.messageId
      ? this.idempotency.recipientLedger(ctx.messageId)
      : undefined;
    const { sent, failed } = await deliverToEach(
      this.email,
      recipients,
      (r) => this.message(r, own.get(r.email) ?? fallback, announcement),
      ledger,
    );
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        eventId: payload.eventId,
        sessionId: payload.sessionId,
        sent,
        failed,
      },
      'Announced session change',
    );
    if (failed > 0) {
      // Surface the partial failure so the message is retried and then parked
      // rather than silently acked. The ledger means the retry re-sends only
      // the ones that did not land. No addresses in the message.
      throw new Error(
        `Session change notice partially failed: ${failed}/${recipients.length} undelivered`,
      );
    }
  }

  /** One reader's notice, in their language. */
  private message(
    recipient: Recipient,
    locale: Locale,
    { payload, event, when, room }: Announcement,
  ): EmailMessage {
    const notice = {
      locale,
      attendeeName: recipient.name,
      eventName: event.name,
      sessionTitle: payload.title,
      when: when ? when[locale] : null,
      room,
    };
    return {
      to: recipient.email,
      subject: sessionChangeSubject(notice),
      text: sessionChangeBody(notice),
      delivery: {
        organizationId: payload.organizationId,
        kind: SESSION_CHANGE_SLUG,
        recipientName: recipient.name,
        eventId: payload.eventId,
      },
    };
  }

  /** Ids only: never a recipient's name, address or the organizer's wording. */
  private skip(
    payload: SessionChangedEvent,
    ctx: MessageContext,
    reason: string,
  ): void {
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        eventId: payload.eventId,
        sessionId: payload.sessionId,
        reason,
      },
      'Session change not announced',
    );
  }
}
