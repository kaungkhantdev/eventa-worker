import { Module } from '@nestjs/common';
import { AuditRepository } from './audit.repository';
import { SignedInHandler } from './signed-in.handler';

/**
 * Identity domain (mirrors eventa-api's bounded context). Providers are plain —
 * the consumer discovers SignedInHandler via DiscoveryService, so no wiring into
 * the RabbitMQ module is needed.
 */
@Module({
  providers: [AuditRepository, SignedInHandler],
})
export class IdentityModule {}
