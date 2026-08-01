import { Module } from '@nestjs/common';
import { AuditRepository } from './audit.repository';
import { SignedInHandler } from './signed-in.handler';

/**
 * Authentication side effects (mirrors eventa-api's `auth` context): consumes
 * `identity.signed_in` and writes the sign-in to the audit trail — the work the API
 * used to do inline on the login request path. Providers are plain; ConsumerService
 * discovers each handler via DiscoveryService, so no wiring into RabbitmqModule.
 */
@Module({
  providers: [AuditRepository, SignedInHandler],
})
export class AuthModule {}
