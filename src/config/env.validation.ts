import { z } from 'zod';

/** Environment schema — the app refuses to start on an invalid env. */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3100),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    RABBITMQ_URL: z.string().min(1, 'RABBITMQ_URL is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    RABBITMQ_EXCHANGE: z.string().default('eventa.events'),
    RABBITMQ_QUEUE: z.string().default('eventa.worker'),
    RABBITMQ_PREFETCH: z.coerce.number().int().positive().default(10),

    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86400),

    /**
     * Closing the orders nobody paid for (US-DISC-05).
     *
     * The cadence is a literal on the `@Cron` decorator (every minute); only
     * the two values that govern correctness live here.
     *
     * The grace is the window a payment webhook still in flight needs to land
     * after a hold lapses. Without it the sweep could tell somebody their seats
     * are gone while their money is on its way.
     */
    ORDER_EXPIRY_GRACE_MS: z.coerce.number().int().positive().default(120_000),
    ORDER_EXPIRY_BATCH: z.coerce.number().int().positive().default(200),

    /**
     * The waitlist (US-REG-04): how long someone offered a seat has to pay for
     * it. Read when the expiry sweep passes a lapsed offer to the next person
     * in line; eventa-api reads the same name for the offers organizers make.
     */
    WAITLIST_OFFER_HOURS: z.coerce.number().int().positive().default(24),

    /**
     * Where the attendee-facing site lives, for links written into email —
     * the survey link in the post-event thank-you (US-MSG-08), the tickets in
     * the reminder, and the page a waitlist offer is paid on (US-REG-04).
     *
     * The same name eventa-api uses. OPTIONAL here: without it the thank-you
     * job does not run and says why, rather than refusing to boot a worker
     * whose other jobs do not need it. A root-relative link is not a fallback —
     * it is inert in a mail client.
     */
    PUBLIC_WEB_URL: z.string().url().optional(),

    /**
     * Scheduled announcements (US-MSG-04/05): how many due ones one sweep
     * sends. The sweep runs every minute, so a backlog drains a batch a minute;
     * the cap keeps one tick's transaction — and the row locks an organizer's
     * cancel waits on — short.
     */
    SCHEDULED_ANNOUNCEMENTS_BATCH: z.coerce
      .number()
      .int()
      .positive()
      .default(50),

    /**
     * The event reminder (US-MSG-01). Sent once an event is this close to
     * STARTING — a day, so it lands while there is still time to plan the trip.
     */
    EVENT_REMINDER_LEAD_HOURS: z.coerce.number().int().positive().default(24),

    /**
     * The post-event thank-you (US-MSG-08). Sent this long after an event ENDS,
     * so it lands the next day rather than while people are still leaving.
     */
    FEEDBACK_REQUEST_DELAY_HOURS: z.coerce
      .number()
      .int()
      .positive()
      .default(24),
    /**
     * How far back the job looks. A guard, not a feature: without it the first
     * run after deployment would thank everybody who ever attended anything.
     */
    FEEDBACK_REQUEST_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
    FEEDBACK_REQUEST_BATCH: z.coerce.number().int().positive().default(20),

    /**
     * How outbound mail leaves — or does not.
     *
     * `log` records that a message was sent and drops it, which is what a dev box
     * wants: no credentials, and no way to mail a real attendee by accident. It
     * is refused in production below.
     */
    EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
    EMAIL_FROM: z.string().min(3).default('Eventa <no-reply@eventa.local>'),

    SMTP_HOST: z.string().min(1).optional(),
    /** Mailpit's default, so the shipped dev setup needs nothing further. */
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    /** Implicit TLS on connect (port 465). STARTTLS is negotiated regardless. */
    SMTP_SECURE: z
      .union([z.boolean(), z.string()])
      .transform((v) => v === true || v === 'true')
      .default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),

    /**
     * How the confirmation TEXT leaves — or does not (US-DISC-06).
     *
     * OPTIONAL, unlike EMAIL_PROVIDER, because there is no SMS account for
     * this product yet and a worker with none must still boot and send email.
     * What "unset" means differs by environment and is decided once, in
     * `resolveSmsTransport`: `log` on a dev box, `off` in production.
     *
     * `off` sends nothing and records nothing. `log` records a send and drops
     * it — right for a dev box, and refused in production below.
     */
    SMS_PROVIDER: z.enum(['off', 'log', 'twilio']).optional(),

    /** Required only for `SMS_PROVIDER=twilio`; never logged, never defaulted. */
    TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    /**
     * The sender Thai carriers will show. Thailand generally requires a
     * REGISTERED alphanumeric sender id; an unregistered long code may be
     * rewritten or dropped by the carrier.
     */
    TWILIO_FROM: z.string().min(1).optional(),
  })
  // A host that is not named cannot be connected to. Find out at boot rather
  // than when somebody is waiting on a verification link.
  .refine((env) => env.EMAIL_PROVIDER !== 'smtp' || !!env.SMTP_HOST, {
    message: 'EMAIL_PROVIDER=smtp requires SMTP_HOST',
    path: ['SMTP_HOST'],
  })
  /**
   * The log provider in production is a silent outage: sign-up says "check your
   * inbox", the outbox drains, the handler reports success, and nobody ever
   * receives a link. A dropped env var must not default into it — the same
   * reasoning as PAYMENT_PROVIDER=fake in eventa-api.
   */
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.EMAIL_PROVIDER === 'smtp',
    {
      message:
        'EMAIL_PROVIDER=log cannot run in production — no confirmation email would ever be delivered.',
      path: ['EMAIL_PROVIDER'],
    },
  )
  // Credentials that are not all there cannot authenticate. As with SMTP_HOST,
  // find out at boot rather than when somebody's confirmation text is owed.
  .superRefine((env, ctx) => {
    if (env.SMS_PROVIDER !== 'twilio') return;
    for (const key of [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM',
    ] as const) {
      if (!env[key])
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `SMS_PROVIDER=twilio requires ${key}`,
          path: [key],
        });
    }
  })
  /**
   * The log provider in production would fill the delivery log with texts that
   * never left, and US-MSG-06 is explicit that the log never claims a delivery
   * the provider has not reported.
   *
   * Unlike EMAIL_PROVIDER, an UNSET value is fine here: there is no SMS
   * account yet, and it resolves to `off` in production — which texts nothing
   * and, crucially, records nothing either.
   */
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.SMS_PROVIDER !== 'log',
    {
      message:
        'SMS_PROVIDER=log cannot run in production — it would log texts as sent that were never sent. Use `off`, or configure a provider.',
      path: ['SMS_PROVIDER'],
    },
  );

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
