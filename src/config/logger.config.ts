import type { ConfigService } from '@nestjs/config';
import type { Params } from 'nestjs-pino';
import type { Env } from './env.validation';

/**
 * Where pino-pretty is installed, or undefined where it is not.
 *
 * It is a devDependency: a checkout has it, the production image does not. And
 * the image does not only run as production: eventa-infra's dev overlay sets
 * NODE_ENV=development, because the worker refuses EMAIL_PROVIDER=log under
 * production. Asked for a transport it cannot find, pino throws while
 * nestjs-pino builds the logger, and the worker never boots. So pretty output
 * needs both a non-production NODE_ENV and the package itself; without it the
 * worker logs the same JSON it logs in production.
 */
function findPrettyPrinter(): string | undefined {
  try {
    return require.resolve('pino-pretty');
  } catch {
    return undefined;
  }
}

/**
 * pino options. The worker is message-driven (the consumer logs each message with
 * its correlation id); the tiny HTTP surface is only health probes, so
 * auto-logging is off to keep probe noise out. Pretty output in development
 * when pino-pretty is installed, silent in tests, JSON lines on stdout
 * otherwise.
 */
export function buildLoggerOptions(
  config: ConfigService<Env, true>,
  prettyPrinter: () => string | undefined = findPrettyPrinter,
): Params {
  const env = config.get('NODE_ENV', { infer: true });
  const isProd = env === 'production';
  const isTest = env === 'test';
  // Resolved here, and handed to pino as a path: the copy found is the copy
  // pino loads.
  const pretty = !isProd && !isTest ? prettyPrinter() : undefined;

  return {
    pinoHttp: {
      level: isTest ? 'silent' : config.get('LOG_LEVEL', { infer: true }),
      autoLogging: false,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        remove: true,
      },
      transport: pretty
        ? {
            target: pretty,
            options: { singleLine: true, translateTime: 'SYS:standard' },
          }
        : undefined,
    },
  };
}
