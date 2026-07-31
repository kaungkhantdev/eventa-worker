import { Global, Module } from '@nestjs/common';
import { EmailProvider } from './email.provider';
import { LogEmailProvider } from './log-email.provider';

/**
 * Provides the EmailProvider port app-wide. Bound to the dev/log provider; swap the
 * useClass for a real SMTP/SES provider (config-selected) without touching handlers.
 */
@Global()
@Module({
  providers: [{ provide: EmailProvider, useClass: LogEmailProvider }],
  exports: [EmailProvider],
})
export class EmailModule {}
