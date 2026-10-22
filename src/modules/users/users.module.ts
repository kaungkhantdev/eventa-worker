import { Module } from '@nestjs/common';
import { EmailChangeHandler } from './email-change.handler';
import { PhoneVerificationHandler } from './phone-verification.handler';
import { UsersRepository } from './users.repository';

/**
 * A member's own profile and identity side effects (mirrors eventa-api's `users`
 * context): consumes `identity.email_change_requested` and sends the two
 * messages one email change owes (US-SET-01) — the confirmation link to the
 * requested address, and a link-free heads-up to the address the account is
 * being moved away from, which is what tells the victim of a stolen session
 * that their account is being taken. Both go through the EmailProvider port.
 *
 * It also consumes `identity.phone_verification_requested` and texts the code
 * that confirms a changed phone number to the requested number (US-DISC-11
 * AC3), through the SmsProvider port.
 *
 * The handlers are not registered with RabbitmqModule — `ConsumerService`
 * discovers them through `DiscoveryService` and binds their routing keys. The
 * EmailProvider and SmsProvider ports come from the global EmailModule and
 * SmsModule, the Drizzle client from the global DatabaseModule, the per-part
 * ledger from the global IdempotencyModule and the degraded-send counter from
 * the global MetricsModule, so this module imports none of them.
 */
@Module({
  providers: [UsersRepository, EmailChangeHandler, PhoneVerificationHandler],
})
export class UsersModule {}
