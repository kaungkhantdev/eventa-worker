import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { AppConfigModule } from './config/config.module';
import type { Env } from './config/env.validation';
import { buildLoggerOptions } from './config/logger.config';
import { DatabaseModule } from './db/database.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
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
    IdempotencyModule,
    RabbitmqModule,
    IdentityModule,
    HealthModule,
  ],
})
export class AppModule {}
