import { Module } from '@nestjs/common';
import { AccountDeletionRequestedHandler } from './account-deletion-requested.handler';
import { AccountDeletionRepository } from './account-deletion.repository';

/**
 * Account-closure side effects (mirrors eventa-api's `account-deletion`
 * context): consumes `identity.account_deletion_requested` and tells the
 * account holder their account has been closed (US-DISC-14).
 *
 * **What this module does NOT do, deliberately.** eventa-api's event comment
 * says the worker "sends the confirmation email, then anonymizes the personal
 * data". Only the first half is here. Anonymizing would mean UPDATEing
 * eventa-api's `users` row, and this service's one standing write exception is
 * `orders` + `seat_holds` for the order-expiry sweep — AGENTS.md is explicit
 * that a second write table is to be agreed first, not assumed ("one
 * clock-driven job is a decision, three is a second API"). So the PDPA scrub is
 * still unimplemented on both sides, and the notice this module sends is
 * careful to claim only what has actually happened.
 */
@Module({
  providers: [AccountDeletionRequestedHandler, AccountDeletionRepository],
})
export class AccountDeletionModule {}
