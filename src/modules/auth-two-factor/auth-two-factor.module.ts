import { Module } from '@nestjs/common';
import { AuthTwoFactorRepository } from './auth-two-factor.repository';
import { TwoFactorDisabledHandler } from './two-factor-disabled.handler';

/**
 * Two-factor side effects (mirrors eventa-api's `auth-two-factor` context):
 * consumes `identity.two_factor_disabled` and alerts the account holder by
 * email, in their own language (US-SET-03).
 *
 * Providers are plain — `ConsumerService` discovers the handler through
 * `DiscoveryService` and binds its routing key, so there is no wiring into
 * RabbitmqModule. The EmailProvider port comes from the global EmailModule and
 * the Drizzle client from the global DatabaseModule, so this module imports
 * neither.
 */
@Module({
  providers: [AuthTwoFactorRepository, TwoFactorDisabledHandler],
})
export class AuthTwoFactorModule {}
