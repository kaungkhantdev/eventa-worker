import { Module } from '@nestjs/common';
import { BookingAccountLinkHandler } from './booking-account-link.handler';

/**
 * Account-from-booking side effects (mirrors eventa-api's `auth-booking-signup`
 * context): consumes `identity.booking_account_link_requested` and mails the
 * one-time link that creates an attendee account from a booking (US-DISC-15)
 * to the booking's own address, through the EmailProvider port (the global
 * EmailModule). The link and its token are made by the API; this side only
 * delivers them. Everything the mail needs is on the message, so the module
 * reads no table and imports nothing.
 *
 * Providers are plain, but they are not optional: `ConsumerService` discovers
 * handlers through `DiscoveryService`, which walks PROVIDERS. A handler no
 * module provides is never bound, and the topic exchange discards its messages
 * without a trace — which is why `app.module.spec.ts` checks this array.
 */
@Module({
  providers: [BookingAccountLinkHandler],
})
export class AuthBookingSignupModule {}
