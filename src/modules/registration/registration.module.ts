import { Module } from '@nestjs/common';
import { EmailModule } from '../../common/email/email.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { PaymentsModule } from '../payments/payments.module';
import { RegistrationConfirmedHandler } from './registration-confirmed.handler';
import { RegistrationRepository } from './registration.repository';

/**
 * Consumes `registration.confirmed` (US-MSG-01) — the confirmation email that
 * carries an attendee's tickets once their order is placed and paid for.
 * Mirrors eventa-api's `checkout` context, which publishes the event; the QR
 * tokens are read from the database here rather than carried on the bus. A
 * paid order's receipt goes from the same handler, through PaymentsModule.
 */
@Module({
  imports: [EmailModule, IdempotencyModule, PaymentsModule],
  providers: [RegistrationRepository, RegistrationConfirmedHandler],
})
export class RegistrationModule {}
