import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { EmailProvider } from './email.provider';
import { LogEmailProvider } from './log-email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';

/** Builds one transport from config. Anything satisfying the port qualifies. */
type TransportFactory = (config: ConfigService<Env, true>) => EmailProvider;

/**
 * The transports this worker can be configured with, keyed by `EMAIL_PROVIDER`.
 *
 * A lookup table rather than a branch, so adding SES or a vendor API is one
 * entry here plus one value on the zod enum — no existing line changes. The
 * `Record` is keyed by the enum's own type, so the compiler REFUSES a new
 * `EMAIL_PROVIDER` value that has no transport behind it: the extension point
 * is enforced rather than merely documented.
 */
const TRANSPORTS: Record<Env['EMAIL_PROVIDER'], TransportFactory> = {
  log: () => new LogEmailProvider(),
  smtp: (config) => new SmtpEmailProvider(config),
};

/**
 * Provides the EmailProvider port app-wide: the transport named by
 * `EMAIL_PROVIDER`, and nothing wrapped around it.
 *
 * Every recipient is mailed, in every environment. A non-production recipient
 * allowlist used to sit here; it was removed deliberately. What that means in
 * practice: whatever address is on the row a handler is processing receives a
 * real message, so a dev box pointed at real SMTP credentials will mail whoever
 * is in its database. `EMAIL_PROVIDER=log` is the way to stop that — it records
 * the send and drops it, needs no credentials, and is the default.
 *
 * Handlers depend on the port alone, so none of this reaches them.
 */
@Global()
@Module({
  providers: [
    {
      provide: EmailProvider,
      useFactory: (config: ConfigService<Env, true>) =>
        TRANSPORTS[config.getOrThrow('EMAIL_PROVIDER', { infer: true })](
          config,
        ),
      inject: [ConfigService],
    },
  ],
  exports: [EmailProvider],
})
export class EmailModule {}
