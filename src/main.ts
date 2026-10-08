import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';

/**
 * Worker entrypoint: a small HTTP surface for health probes; the RabbitMQ
 * consumer starts on application bootstrap (ConsumerService).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  app
    .get(Logger)
    .log(
      `eventa-worker up on :${port} (health) — consumer bootstrapping`,
      'Bootstrap',
    );
}

void bootstrap();
