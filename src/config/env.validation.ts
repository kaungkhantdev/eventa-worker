import { z } from 'zod';

/** Environment schema — the app refuses to start on an invalid env. */
export const envSchema = z.object({
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
});

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
