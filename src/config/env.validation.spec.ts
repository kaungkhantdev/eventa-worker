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

  /**
   * The meeting invite, its Meet link and its reminder (US-MTG-04/08). Every
   * one of these is optional: a worker with no Google client must still boot,
   * send email, and say "not connected" on each meeting rather than refuse.
   */
  describe('Google Calendar (US-MTG-04/08)', () => {
    const DEV_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
    const client = {
      GOOGLE_CALENDAR_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CALENDAR_CLIENT_SECRET: 'client-secret',
    };
    /** A 32-byte key that is not the published dev default. */
    const realKey = Buffer.alloc(32, 7).toString('base64');

    it('boots with no calendar configuration whatsoever', () => {
      const env = validateEnv(base);
      expect(env.CALENDAR_PROVIDER).toBeUndefined();
      expect(env.GOOGLE_CALENDAR_CLIENT_ID).toBeUndefined();
      expect(env.GOOGLE_CALENDAR_CLIENT_SECRET).toBeUndefined();
    });

    it('accepts each provider name and refuses any other', () => {
      for (const name of ['off', 'fake'] as const) {
        expect(
          validateEnv({ ...base, CALENDAR_PROVIDER: name }).CALENDAR_PROVIDER,
        ).toBe(name);
      }
      expect(() =>
        validateEnv({ ...base, CALENDAR_PROVIDER: 'outlook' }),
      ).toThrow(/CALENDAR_PROVIDER/);
    });

    it('refuses google without both halves of the OAuth client', () => {
      expect(() =>
        validateEnv({ ...base, CALENDAR_PROVIDER: 'google' }),
      ).toThrow(/GOOGLE_CALENDAR_CLIENT_ID/);
      expect(() =>
        validateEnv({
          ...base,
          CALENDAR_PROVIDER: 'google',
          GOOGLE_CALENDAR_CLIENT_ID: client.GOOGLE_CALENDAR_CLIENT_ID,
        }),
      ).toThrow(/GOOGLE_CALENDAR_CLIENT_SECRET/);
    });

    it('accepts google once both halves are given', () => {
      const env = validateEnv({
        ...base,
        CALENDAR_PROVIDER: 'google',
        ...client,
      });
      expect(env.CALENDAR_PROVIDER).toBe('google');
    });

    it('refuses an empty client id or secret', () => {
      expect(() =>
        validateEnv({ ...base, ...client, GOOGLE_CALENDAR_CLIENT_ID: '' }),
      ).toThrow(/GOOGLE_CALENDAR_CLIENT_ID/);
      expect(() =>
        validateEnv({ ...base, ...client, GOOGLE_CALENDAR_CLIENT_SECRET: '' }),
      ).toThrow(/GOOGLE_CALENDAR_CLIENT_SECRET/);
    });

    /**
     * The fake answers every call with a made-up event and Meet link. In
     * production that is a silent outage: cards read "synced" and no guest is
     * ever invited — the same reasoning as EMAIL_PROVIDER=log.
     */
    it('refuses the fake in production, with the sentence the api uses', () => {
      expect(() =>
        validateEnv({ ...production, CALENDAR_PROVIDER: 'fake' }),
      ).toThrow(
        'CALENDAR_PROVIDER=fake cannot run in production — no invite would ever reach Google.',
      );
    });

    it('allows the fake outside production', () => {
      expect(() =>
        validateEnv({ ...base, NODE_ENV: 'test', CALENDAR_PROVIDER: 'fake' }),
      ).not.toThrow();
    });

    describe('SECRET_ENCRYPTION_KEY', () => {
      it("defaults to eventa-api's published dev key", () => {
        expect(validateEnv(base).SECRET_ENCRYPTION_KEY).toBe(DEV_KEY);
      });

      it('refuses a key that is not base64 of 32 bytes', () => {
        expect(() =>
          validateEnv({
            ...base,
            SECRET_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
          }),
        ).toThrow('SECRET_ENCRYPTION_KEY must be base64 of 32 bytes');
      });

      /**
       * The worker decrypts refresh tokens eventa-api encrypted. In production
       * the dev default can only mean the variable was never copied across, and
       * every sync would end "could not be read" — so find out at boot.
       */
      it('refuses the dev default in production when Google is the provider', () => {
        expect(() =>
          validateEnv({
            ...production,
            CALENDAR_PROVIDER: 'google',
            ...client,
          }),
        ).toThrow(
          "SECRET_ENCRYPTION_KEY must be set to eventa-api's key in production.",
        );
      });

      it('refuses it when Google is the provider by derivation, too', () => {
        // Both client variables set and CALENDAR_PROVIDER unset resolves to
        // google, so the same refusal must apply.
        expect(() => validateEnv({ ...production, ...client })).toThrow(
          /SECRET_ENCRYPTION_KEY/,
        );
      });

      it('accepts a real key in production with Google', () => {
        expect(() =>
          validateEnv({
            ...production,
            ...client,
            CALENDAR_PROVIDER: 'google',
            SECRET_ENCRYPTION_KEY: realKey,
          }),
        ).not.toThrow();
      });

      it('lets production keep the dev default while the calendar is off', () => {
        // Nothing is decrypted, so nothing is at stake.
        expect(() => validateEnv(production)).not.toThrow();
        expect(() =>
          validateEnv({ ...production, ...client, CALENDAR_PROVIDER: 'off' }),
        ).not.toThrow();
      });
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
