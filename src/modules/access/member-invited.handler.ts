import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { safeDisplayName } from '../../common/messaging/display-name';
import { greeting } from '../../common/messaging/greeting';
import { inlineText } from '../../common/messaging/inline-text';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import {
  IDENTITY_MEMBER_INVITED,
  type MemberInvitedEvent,
  memberInvitedSchema,
} from './member-invited.schema';

/**
 * The join link a teammate is invited with (US-SET-11).
 *
 * "Given a new person's name, email and role, when I send an invite, then
 * they appear as 'Invited' and receive a join link by email." They appeared
 * as Invited from the start; the link was handed back in the API's response
 * and never sent anywhere, which `InviteResponseDto` admitted in its own
 * docstring. This is the half that was missing.
 *
 * ENGLISH ONLY, like the sign-up confirmation beside it and for the same
 * reason: the reader has no account yet, so there is no locale to read. The
 * workspace has one, and passing it on the event is what this would need to
 * become bilingual.
 */
@Injectable()
export class MemberInvitedHandler extends ValidatedHandler<MemberInvitedEvent> {
  readonly routingKey = IDENTITY_MEMBER_INVITED;
  protected readonly schema = memberInvitedSchema;
  private readonly logger = new Logger(MemberInvitedHandler.name);

  constructor(private readonly email: EmailProvider) {
    super();
  }

  protected async process(
    payload: MemberInvitedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    await this.email.send({
      to: payload.email,
      subject: subjectFor(payload.organizationName),
      text: this.body(payload),
    });
    // No delivery context: account mail is not the organizer's message log —
    // filing somebody's own invitation under a workspace would show it to
    // colleagues who have no business reading it.
    this.logger.log(
      { correlationId: ctx.correlationId, userId: payload.userId },
      'Sent member invitation',
    );
  }

  private body(payload: MemberInvitedEvent): string {
    const workspace = inlineText(payload.organizationName);
    return [
      // The name is free text an ADMIN typed about somebody else, and this
      // mail carries a credential — so it takes the SECURITY rule
      // (`safeDisplayName`, an allow-list that declines anything not shaped
      // like a name) rather than the sanitising one attendee notices use.
      // `greeting` turns a declined name into `Hi,`.
      greeting('en', safeDisplayName(payload.name) ?? ''),
      '',
      `You have been invited to join ${workspace} on Eventa.`,
      '',
      'Set a password to accept and get started:',
      payload.acceptUrl,
      '',
      'If you were not expecting this, you can ignore this email — nothing',
      'happens until you set a password.',
    ].join('\n');
  }
}

/**
 * Flattened: the workspace name is whatever an organizer typed into their
 * settings, and a second line in a subject is a second header.
 */
export function subjectFor(organizationName: string): string {
  return inlineText(`You have been invited to join ${organizationName}`);
}
