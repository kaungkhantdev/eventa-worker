import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    RABBITMQ_URL: 'amqp://localhost:5672',
    REDIS_URL: 'redis://localhost:6379',
  };

  /** A production env whose EMAIL rules already pass, so SMS is what is tested. */
  const production = {
    ...base,
    NODE_ENV: 'production',
    EMAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.com',
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

  /**
   * The confirmation text (US-DISC-06). There is no SMS account for this
   * product yet, so every one of these is OPTIONAL — a worker with no SMS
   * config at all must still boot and send email.
   */
  describe('SMS delivery', () => {
    it('boots with no SMS configuration whatsoever', () => {
      expect(validateEnv(base).SMS_PROVIDER).toBeUndefined();
    });

    it('refuses twilio without the credentials to use it', () => {
      // Find out at boot, not when somebody's confirmation text is owed.
      expect(() => validateEnv({ ...base, SMS_PROVIDER: 'twilio' })).toThrow(
        /TWILIO_ACCOUNT_SID/,
      );
      expect(() =>
        validateEnv({
          ...base,
          SMS_PROVIDER: 'twilio',
          TWILIO_ACCOUNT_SID: 'AC1',
          TWILIO_AUTH_TOKEN: 'secret',
        }),
      ).toThrow(/TWILIO_FROM/);
    });

    it('accepts twilio once all three are given', () => {
      const env = validateEnv({
        ...base,
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 'secret',
        TWILIO_FROM: 'Eventa',
      });
      expect(env.SMS_PROVIDER).toBe('twilio');
    });

    /**
     * The log provider in production would fill the delivery log with texts
     * that never left — US-MSG-06 is explicit that the log never claims a
     * delivery the provider has not reported. `off` is the honest setting for
     * a deployment with no SMS account.
     */
    it('refuses the log provider in production', () => {
      expect(() => validateEnv({ ...production, SMS_PROVIDER: 'log' })).toThrow(
        /SMS_PROVIDER/,
      );
    });

    it('allows production to switch SMS off outright', () => {
      expect(() =>
        validateEnv({ ...production, SMS_PROVIDER: 'off' }),
      ).not.toThrow();
    });

    it('lets production boot with SMS unconfigured', () => {
      // There is no SMS account for this product yet. A worker that refused to
      // start without one would take email down with it.
      expect(() => validateEnv(production)).not.toThrow();
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

  it('sends scheduled announcements fifty at a time unless told otherwise', () => {
    expect(validateEnv(base).SCHEDULED_ANNOUNCEMENTS_BATCH).toBe(50);
    expect(
      validateEnv({ ...base, SCHEDULED_ANNOUNCEMENTS_BATCH: '10' })
        .SCHEDULED_ANNOUNCEMENTS_BATCH,
    ).toBe(10);
  });
});
