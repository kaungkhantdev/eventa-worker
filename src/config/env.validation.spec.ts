import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    RABBITMQ_URL: 'amqp://localhost:5672',
    REDIS_URL: 'redis://localhost:6379',
  };

  it('rejects an env missing RABBITMQ_URL', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: base.DATABASE_URL,
        REDIS_URL: base.REDIS_URL,
      }),
    ).toThrow(/RABBITMQ_URL/);
  });

  it('applies defaults', () => {
    const env = validateEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3100);
    expect(env.RABBITMQ_EXCHANGE).toBe('eventa.events');
    expect(env.RABBITMQ_QUEUE).toBe('eventa.worker');
    expect(env.RABBITMQ_PREFETCH).toBe(10);
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86400);
  });
});
