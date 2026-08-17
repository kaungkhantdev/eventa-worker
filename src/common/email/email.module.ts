import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { parseAllowlist } from './email-allowlist';
import { EmailProvider } from './email.provider';
import { GuardedEmailProvider } from './guarded-email.provider';
import { LogEmailProvider } from './log-email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';

/**
 * Provides the EmailProvider port app-wide: a transport chosen by
 * `EMAIL_PROVIDER`, wrapped in the non-production recipient guard.
 *
 * Defaults to the log provider, so a dev box needs no credentials and cannot
 * mail a real attendee by accident. The env schema refuses that default in
 * production, where it would be a silent outage rather than a safe one.
 *
 * The guard wraps whichever transport is chosen, because the risk is not the
 * transport — it is pointing any real one at a database full of seeded
 * addresses. In production it passes everything through.
 *
 * Handlers depend on the port alone, so none of this reaches them.
 */
@Global()
@Module({
  providers: [
    {
      provide: EmailProvider,
      useFactory: (config: ConfigService<Env, true>) => {
        const transport =
          config.getOrThrow('EMAIL_PROVIDER', { infer: true }) === 'smtp'
            ? new SmtpEmailProvider(config)
            : new LogEmailProvider();
        return new GuardedEmailProvider(
          transport,
          parseAllowlist(config.get('EMAIL_ALLOWLIST', { infer: true })),
          config.getOrThrow('NODE_ENV', { infer: true }) === 'production',
        );
      },
      inject: [ConfigService],
    },
  ],
  exports: [EmailProvider],
})
export class EmailModule {}
