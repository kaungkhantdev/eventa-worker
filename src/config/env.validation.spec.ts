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

  describe('email delivery', () => {
    // Nothing leaves the machine by default, so a dev box cannot mail a real
    // attendee by accident.
    it('defaults to the log provider', () => {
      expect(validateEnv(base).EMAIL_PROVIDER).toBe('log');
    });

    it('names a sender, so a real provider is never asked to guess one', () => {
      expect(validateEnv(base).EMAIL_FROM).toContain('@');
    });

    // A host that is not named cannot be connected to. Find out at boot rather
    // than when somebody is waiting on a verification link.
    it('refuses smtp without a host', () => {
      expect(() => validateEnv({ ...base, EMAIL_PROVIDER: 'smtp' })).toThrow(
        /SMTP_HOST/,
      );
    });

    it('accepts smtp once the host is given', () => {
      const env = validateEnv({
        ...base,
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'localhost',
      });
      expect(env.EMAIL_PROVIDER).toBe('smtp');
      // Mailpit's port, so the shipped dev setup needs nothing further.
      expect(env.SMTP_PORT).toBe(1025);
      expect(env.SMTP_SECURE).toBe(false);
    });

    /**
     * The log provider in production is a silent outage: sign-up says "check
     * your inbox", the outbox drains, the handler reports success, and nobody
     * ever receives a link. A dropped env var must not default into it — the
     * same reasoning as PAYMENT_PROVIDER=fake in eventa-api.
     */
    it('refuses the log provider in production', () => {
      expect(() =>
        validateEnv({ ...base, NODE_ENV: 'production', EMAIL_PROVIDER: 'log' }),
      ).toThrow(/EMAIL_PROVIDER/);
    });

    it('allows smtp in production', () => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          EMAIL_PROVIDER: 'smtp',
          SMTP_HOST: 'smtp.example.com',
        }),
      ).not.toThrow();
    });
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
