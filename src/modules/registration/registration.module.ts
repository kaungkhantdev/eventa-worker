import { Module } from '@nestjs/common';
import { EmailModule } from '../../common/email/email.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { SmsModule } from '../../common/sms/sms.module';
import { EventsModule } from '../events/events.module';
import { PaymentsModule } from '../payments/payments.module';
import { RegistrationConfirmedHandler } from './registration-confirmed.handler';
import { RegistrationRejectedHandler } from './registration-rejected.handler';
import { RegistrationRepository } from './registration.repository';

/**
 * The two sides of a registration's outcome, mirroring eventa-api's `checkout`
 * context, which publishes both:
 *
 * - `registration.confirmed` (US-MSG-01) — the confirmation email that carries
 *   an attendee's tickets once their order is placed and paid for. The QR
 *   tokens are read from the database here rather than carried on the bus. A
 *   paid order's receipt goes from the same handler, through PaymentsModule,
 *   and the confirmation TEXT (US-DISC-06) through SmsModule.
 * - `registration.rejected` (US-REG-02) — the notice to somebody an organizer
 *   turned down, including what became of their money.
 *
 * They live together because they are one decision's two answers and read the
 * same tables through one repository; EventsModule supplies the reader's
 * language, the same way the waitlist emails get theirs.
 */
@Module({
  imports: [
    EmailModule,
    SmsModule,
    IdempotencyModule,
    PaymentsModule,
    EventsModule,
  ],
  providers: [
    RegistrationRepository,
    RegistrationConfirmedHandler,
    RegistrationRejectedHandler,
  ],
})
export class RegistrationModule {}
