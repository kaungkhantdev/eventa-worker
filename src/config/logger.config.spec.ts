import type { ConfigService } from '@nestjs/config';
import type { Env } from './env.validation';
import { buildLoggerOptions } from './logger.config';

/**
 * Pretty logs follow what is installed, not NODE_ENV alone.
 *
 * pino-pretty is a devDependency, so the production image does not have it —
 * and the image is not only run as production: eventa-infra's dev overlay sets
 * NODE_ENV=development (it needs EMAIL_PROVIDER=log, which production refuses).
 * Asking pino for a transport it cannot find throws while nestjs-pino builds
 * the logger, so every such pod failed at boot.
 */
function configFor(nodeEnv: Env['NODE_ENV']): ConfigService<Env, true> {
  return {
    get: (key: string) => (key === 'NODE_ENV' ? nodeEnv : 'info'),
  } as unknown as ConfigService<Env, true>;
}

type PinoHttpOptions = { transport?: { target: string } };

function transportFor(
  nodeEnv: Env['NODE_ENV'],
  findPrettyPrinter?: () => string | undefined,
): PinoHttpOptions['transport'] {
  const options = buildLoggerOptions(configFor(nodeEnv), findPrettyPrinter);
  return (options.pinoHttp as PinoHttpOptions).transport;
}

const notInstalled = () => undefined;
const installedAt = () => '/checkout/node_modules/pino-pretty/index.js';

describe('the log format', () => {
  it('is JSON in development when pino-pretty is not installed (the production image)', () => {
    expect(transportFor('development', notInstalled)).toBeUndefined();
  });

  it('is pretty in development when pino-pretty is installed (a checkout)', () => {
    expect(transportFor('development', installedAt)).toEqual(
      expect.objectContaining({
        target: '/checkout/node_modules/pino-pretty/index.js',
      }),
    );
  });

  it('finds pino-pretty in this checkout, where it is a devDependency', () => {
    expect(transportFor('development')?.target).toMatch(/pino-pretty/);
  });

  it('is JSON in production even where pino-pretty is installed', () => {
    expect(transportFor('production', installedAt)).toBeUndefined();
  });

  it('is JSON in test even where pino-pretty is installed', () => {
    expect(transportFor('test', installedAt)).toBeUndefined();
  });
});
