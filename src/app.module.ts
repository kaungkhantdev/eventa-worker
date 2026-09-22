import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { EmailModule } from './common/email/email.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { MessagingModule } from './common/messaging/messaging.module';
import { AppConfigModule } from './config/config.module';
import type { Env } from './config/env.validation';
import { buildLoggerOptions } from './config/logger.config';
import { DatabaseModule } from './db/database.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthModule } from './health/health.module';
import { EventsModule } from './modules/events/events.module';
import { ScheduledMessagesModule } from './modules/scheduled-messages/scheduled-messages.module';
import { WaitlistModule } from './modules/waitlist/waitlist.module';
import { OrderExpiryModule } from './modules/order-expiry/order-expiry.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RegistrationModule } from './modules/registration/registration.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthPasswordModule } from './modules/auth-password/auth-password.module';
import { AuthSignupModule } from './modules/auth-signup/auth-signup.module';
import { AuthTwoFactorModule } from './modules/auth-two-factor/auth-two-factor.module';
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
    IdempotencyModule,
    MessagingModule,
    RabbitmqModule,
    AuthModule,
    AuthSignupModule,
    AuthPasswordModule,
    AuthTwoFactorModule,
    EventsModule,
    ScheduledMessagesModule,
    WaitlistModule,
    RegistrationModule,
    PaymentsModule,
    OrderExpiryModule,
    MetricsModule,
    HealthModule,
  ],
})
export class AppModule {}
