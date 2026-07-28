import type { ConfigService } from '@nestjs/config';
import type { Params } from 'nestjs-pino';
import type { Env } from './env.validation';

/**
 * pino options. The worker is message-driven (the consumer logs each message with
 * its correlation id); the tiny HTTP surface is only health probes, so
 * auto-logging is off to keep probe noise out.
 */
export function buildLoggerOptions(config: ConfigService<Env, true>): Params {
  const env = config.get('NODE_ENV', { infer: true });
  const isProd = env === 'production';
  const isTest = env === 'test';

  return {
    pinoHttp: {
      level: isTest ? 'silent' : config.get('LOG_LEVEL', { infer: true }),
      autoLogging: false,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        remove: true,
      },
      transport:
        !isProd && !isTest
          ? {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'SYS:standard' },
            }
          : undefined,
    },
  };
}
