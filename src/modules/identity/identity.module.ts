import { Module } from '@nestjs/common';
import { AuditRepository } from './audit.repository';
import { EmailVerificationHandler } from './email-verification.handler';
import { PasswordResetHandler } from './password-reset.handler';
import { SignedInHandler } from './signed-in.handler';

/**
 * Identity domain (mirrors eventa-api's bounded context). Providers are plain —
 * the consumer discovers each handler via DiscoveryService, so no wiring into the
 * RabbitMQ module is needed. The email handlers send sign-up confirmations and
 * password-reset links via the EmailProvider port (EmailModule).
 */
@Module({
  providers: [
    AuditRepository,
    SignedInHandler,
    EmailVerificationHandler,
    PasswordResetHandler,
  ],
})
export class IdentityModule {}
