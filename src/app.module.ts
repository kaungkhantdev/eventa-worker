import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { EmailModule } from './common/email/email.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { AppConfigModule } from './config/config.module';
import type { Env } from './config/env.validation';
import { buildLoggerOptions } from './config/logger.config';
import { DatabaseModule } from './db/database.module';
import { HealthModule } from './health/health.module';
import { EventsModule } from './modules/events/events.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthPasswordModule } from './modules/auth-password/auth-password.module';
import { AuthSignupModule } from './modules/auth-signup/auth-signup.module';
import { RabbitmqModule } from './rabbitmq/rabbitmq.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        buildLoggerOptions(config),
    }),
    DatabaseModule,
    EmailModule,
    IdempotencyModule,
    RabbitmqModule,
    AuthModule,
    AuthSignupModule,
    AuthPasswordModule,
    EventsModule,
    HealthModule,
  ],
})
export class AppModule {}
