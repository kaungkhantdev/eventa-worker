import { Module } from '@nestjs/common';
import { AuditRepository } from './audit.repository';
import { EmailVerificationHandler } from './email-verification.handler';
import { SignedInHandler } from './signed-in.handler';

/**
 * Identity domain (mirrors eventa-api's bounded context). Providers are plain —
 * the consumer discovers each handler via DiscoveryService, so no wiring into the
 * RabbitMQ module is needed. EmailVerificationHandler sends sign-up confirmations
 * via the EmailProvider port (EmailModule).
 */
@Module({
  providers: [AuditRepository, SignedInHandler, EmailVerificationHandler],
})
export class IdentityModule {}
