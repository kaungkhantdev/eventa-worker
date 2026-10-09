import { Module } from '@nestjs/common';
import { EmailChangeHandler } from './email-change.handler';
import { UsersRepository } from './users.repository';

/**
 * A member's own profile and identity side effects (mirrors eventa-api's `users`
 * context): consumes `identity.email_change_requested` and sends the two
 * messages one email change owes (US-SET-01) — the confirmation link to the
 * requested address, and a link-free heads-up to the address the account is
 * being moved away from, which is what tells the victim of a stolen session
 * that their account is being taken. Both go through the EmailProvider port.
 *
 * The handler is not registered with RabbitmqModule — `ConsumerService` discovers
 * it through `DiscoveryService` and binds its routing key. The EmailProvider
 * port comes from the global EmailModule, the Drizzle client from the global
 * DatabaseModule and the per-part ledger from the global IdempotencyModule, so
 * this module imports none of them.
 */
@Module({
  providers: [UsersRepository, EmailChangeHandler],
})
export class UsersModule {}
