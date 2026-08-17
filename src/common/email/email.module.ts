import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { EmailProvider } from './email.provider';
import { LogEmailProvider } from './log-email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';

/**
 * Provides the EmailProvider port app-wide, chosen by `EMAIL_PROVIDER`.
 *
 * Defaults to the log provider, so a dev box needs no credentials and cannot
 * mail a real attendee by accident. The env schema refuses that default in
 * production, where it would be a silent outage rather than a safe one — the
 * same guard `PAYMENT_PROVIDER=fake` carries in eventa-api.
 *
 * Handlers depend on the port alone, so neither choice reaches them.
 */
@Global()
@Module({
  providers: [
    {
      provide: EmailProvider,
      useFactory: (config: ConfigService<Env, true>) =>
        config.getOrThrow('EMAIL_PROVIDER', { infer: true }) === 'smtp'
          ? new SmtpEmailProvider(config)
          : new LogEmailProvider(),
      inject: [ConfigService],
    },
  ],
  exports: [EmailProvider],
})
export class EmailModule {}
