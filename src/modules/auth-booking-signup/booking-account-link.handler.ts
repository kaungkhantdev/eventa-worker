import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import {
  bookingAccountLinkBody,
  bookingAccountLinkSubject,
} from './booking-account-link.notice';
import {
  type BookingAccountLinkRequestedEvent,
  IDENTITY_BOOKING_ACCOUNT_LINK_REQUESTED,
  bookingAccountLinkRequestedSchema,
} from './booking-account-link.schema';

/**
 * Handles `identity.booking_account_link_requested` (US-DISC-15): mails the
 * one-time link that turns a booking into an attendee account to the booking's
 * own address. Opening it is the proof that the address belongs to the reader,
 * so this mail is the only way such an account comes to exist. The link and its
 * token are made by eventa-api; this handler only delivers them.
 *
 * Shaped like `password-reset.handler.ts`, its closest sibling:
 *
 * - **Unconditional.** No template slug and no `delivery` context: it is the
 *   person's own account mail, not a workspace's correspondence, and it is not
 *   filed in any organizer's delivery log.
 * - **Everything it needs is on the message**, language included, so it reads
 *   no table and no database outage can hold it back.
 * - **Idempotency is `ConsumerService`'s.** It records the message id as
 *   completed only after this returns, and there is one recipient, so no
 *   ledger here. A failed send is rethrown, never swallowed: `failure.ts`
 *   decides whether it rides the retry ladder or parks.
 *
 * NEITHER THE LINK NOR THE ADDRESS MAY REACH A LOG. The token is the whole
 * credential and the address is personal data; the one log line carries ids.
 */
@Injectable()
export class BookingAccountLinkHandler extends ValidatedHandler<BookingAccountLinkRequestedEvent> {
  readonly routingKey = IDENTITY_BOOKING_ACCOUNT_LINK_REQUESTED;
  protected readonly schema = bookingAccountLinkRequestedSchema;
  private readonly logger = new Logger(BookingAccountLinkHandler.name);

  constructor(private readonly email: EmailProvider) {
    super();
  }

  protected async process(
    payload: BookingAccountLinkRequestedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const notice = {
      locale: payload.locale,
      name: payload.name,
      eventName: payload.eventName,
      claimUrl: payload.claimUrl,
      expiresAt: new Date(payload.expiresAt),
    };
    await this.email.send({
      to: payload.email,
      subject: bookingAccountLinkSubject(notice),
      text: bookingAccountLinkBody(notice),
    });
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        orderId: payload.orderId,
        locale: payload.locale,
      },
      'Sent the link that creates an account from a booking',
    );
  }
}
