import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { EmailModule } from './common/email/email.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { MessagingModule } from './common/messaging/messaging.module';
import { SmsModule } from './common/sms/sms.module';
import { AppConfigModule } from './config/config.module';
import type { Env } from './config/env.validation';
import { buildLoggerOptions } from './config/logger.config';
import { DatabaseModule } from './db/database.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthModule } from './health/health.module';
import { EventsModule } from './modules/events/events.module';
import { EventProgramModule } from './modules/event-program/event-program.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { ScheduledMessagesModule } from './modules/scheduled-messages/scheduled-messages.module';
import { WaitlistModule } from './modules/waitlist/waitlist.module';
import { OrderExpiryModule } from './modules/order-expiry/order-expiry.module';
import { ScheduledAnnouncementsModule } from './modules/scheduled-announcements/scheduled-announcements.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RegistrationModule } from './modules/registration/registration.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthPasswordModule } from './modules/auth-password/auth-password.module';
import { AccessModule } from './modules/access/access.module';
import { AuthSignupModule } from './modules/auth-signup/auth-signup.module';
import { AuthTwoFactorModule } from './modules/auth-two-factor/auth-two-factor.module';
import { AccountDeletionModule } from './modules/account-deletion/account-deletion.module';
import { UsersModule } from './modules/users/users.module';
import { RabbitmqModule } from './rabbitmq/rabbitmq.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        buildLoggerOptions(config),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    EmailModule,
    SmsModule,
    IdempotencyModule,
    MessagingModule,
    RabbitmqModule,
    AuthModule,
    AccessModule,
    AuthSignupModule,
    AuthPasswordModule,
    AuthTwoFactorModule,
    AccountDeletionModule,
    UsersModule,
    EventsModule,
    EventProgramModule,
    InvitationsModule,
    ScheduledMessagesModule,
    WaitlistModule,
    RegistrationModule,
    PaymentsModule,
    OrderExpiryModule,
    ScheduledAnnouncementsModule,
    MetricsModule,
    HealthModule,
  ],
})
export class AppModule {}
