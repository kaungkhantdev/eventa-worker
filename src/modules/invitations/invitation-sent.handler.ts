import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import {
  type ChosenWording,
  pickWording,
} from '../../common/messaging/merge-fields';
import { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import type { Locale } from '../../db/schema/events';
import { EVENT_INVITATION_SLUG } from '../../db/schema/messaging';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import { EventRecipientsRepository } from '../events/event-recipients.repository';
import { readerLocale } from '../events/reader-locale';
import { formatWhen } from '../registration/confirmation-email';
import {
  type InvitationNotice,
  invitationBody,
  invitationSubject,
} from './invitation-email';
import { invitationGreetingName } from './invitation-name';
import { personalisedWording } from './invitation-wording';
import {
  INVITATION_SENT,
  type InvitationSentEvent,
  invitationSentSchema,
} from './invitation-sent.schema';
import {
  type InvitationEvent,
  InvitationsRepository,
  stillInvitable,
} from './invitations.repository';

/**
 * What became of one invitation, for the single log line this handler writes.
 *
 * A named union rather than four bare strings: the line is what an operator
 * reads to find out why somebody was never invited, and a typo in it is a
 * question nobody can answer. `const enum` is not an option — `isolatedModules`
 * is on.
 */
const OUTCOME = {
  sent: 'sent',
  noEvent: 'no-event',
  cancelled: 'event-cancelled',
  switchedOff: 'switched-off',
} as const;

type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

/**
 * Handles `invitation.sent` (US-REG-06): the email an organizer's invitation
 * actually arrives as, carrying their personal note and the link that
 * registers for the event.
 *
 * Until this existed the routing key reached the topic exchange with nothing
 * bound to it, so every invitation an organizer sent was discarded by the
 * broker — no failure, no retry, no dead letter, no trace.
 *
 * Four things shape it:
 *
 * - **The tenant comes from the EVENT, not the message.** Alone among
 *   eventa-api's events, this one carries no `organizationId` on its payload.
 *   See {@link InvitationsRepository.invitedEvent}.
 * - **The organizer can switch it off** (`message_templates.active`), because
 *   this is attendee-facing mail the workspace sends rather than identity mail
 *   somebody is owed — the split that keeps `password-reset` and
 *   `email-verification` ungated. An absent row means ON, so a workspace that
 *   has never opened its message settings still invites people.
 * - **The event is re-read before sending.** The outbox and the queue can run
 *   behind, and an invitation to an event that has since been cancelled or
 *   deleted is worse than no invitation. Nothing sent is still a success.
 * - **The name is the organizer's claim, not the reader's own.** Every other
 *   greeting in this service prints a name its own reader wrote; this one
 *   prints what an organizer typed about a stranger, and mails it to an
 *   address of the organizer's choosing. `invitation-name.ts` is the rule that
 *   follows from that, and the honest account of what it does not reach.
 * - **Nothing about the recipient reaches a log line.** The address and the
 *   name are PII, and the register link is what gets somebody a place. The log
 *   carries the event id and the outcome; that is enough to follow a message
 *   through. `invitationId` is NOT an id for this purpose — eventa-api builds
 *   it as `${eventId}:${recipientEmail}`.
 *
 * Idempotency is on the MESSAGE id. A re-invitation outside eventa-api's
 * 24-hour suppression window is a fresh outbox row for the same pair, and must
 * send; deduping on the invitation would silence every one of them.
 */
@Injectable()
export class InvitationSentHandler extends ValidatedHandler<InvitationSentEvent> {
  readonly routingKey = INVITATION_SENT;
  protected readonly schema = invitationSentSchema;
  private readonly logger = new Logger(InvitationSentHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly repo: InvitationsRepository,
    private readonly templates: MessageTemplatesRepository,
    private readonly recipients: EventRecipientsRepository,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  protected async process(
    payload: InvitationSentEvent,
    ctx: MessageContext,
  ): Promise<void> {
    if (ctx.messageId && (await this.idempotency.isCompleted(ctx.messageId))) {
      return;
    }
    const outcome = await this.invite(payload);
    if (ctx.messageId) await this.idempotency.markCompleted(ctx.messageId);
    this.logger.log(
      { correlationId: ctx.correlationId, eventId: payload.eventId, outcome },
      'Event invitation',
    );
  }

  /** Send it, or say which of the three reasons stopped it. */
  private async invite(payload: InvitationSentEvent): Promise<Outcome> {
    const event = await this.repo.invitedEvent(payload.eventId);
    if (!event) return OUTCOME.noEvent;
    if (!stillInvitable(event)) return OUTCOME.cancelled;
    const on = await this.templates.isActive(
      event.organizationId,
      EVENT_INVITATION_SLUG,
    );
    if (!on) return OUTCOME.switchedOff;
    await this.send(payload, event);
    return OUTCOME.sent;
  }

  private async send(
    payload: InvitationSentEvent,
    event: InvitationEvent,
  ): Promise<void> {
    const notice = await this.compose(payload, event);
    await this.email.send({
      to: payload.recipientEmail,
      subject: invitationSubject(notice),
      text: invitationBody(notice),
      delivery: {
        organizationId: event.organizationId,
        kind: EVENT_INVITATION_SLUG,
        recipientName: payload.recipientName,
        eventId: payload.eventId,
      },
    });
  }

  private async compose(
    payload: InvitationSentEvent,
    event: InvitationEvent,
  ): Promise<InvitationNotice> {
    const locale = await readerLocale(this.recipients, {
      organizationId: event.organizationId,
      eventId: payload.eventId,
      email: payload.recipientEmail,
    });
    // The name is free text an organizer typed into a form about somebody
    // else. `invitationGreetingName` is what stops a newline, a host, a phone
    // number or a Thai sentence in it writing their own line into a mail
    // Eventa signs — and its docstring records what it cannot stop.
    const name = invitationGreetingName(payload.recipientName);
    const wording = personalisedWording(await this.wording(event, locale), {
      name,
      eventName: event.eventName,
    });
    return {
      locale,
      name,
      eventName: event.eventName,
      whenText: formatWhen(event.startAt, event.timezone, locale),
      registerUrl: payload.registerUrl,
      note: payload.message ?? null,
      subject: wording.subject,
      opening: wording.body,
    };
  }

  /** The organizer's own subject and opening, in this reader's language. */
  private async wording(
    event: InvitationEvent,
    locale: Locale,
  ): Promise<ChosenWording> {
    return pickWording(
      await this.templates.wordingFor(
        event.organizationId,
        EVENT_INVITATION_SLUG,
      ),
      locale,
    );
  }
}
