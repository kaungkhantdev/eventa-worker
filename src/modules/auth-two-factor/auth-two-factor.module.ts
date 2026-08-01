import { Module } from '@nestjs/common';
import { TwoFactorDisabledHandler } from './two-factor-disabled.handler';

/**
 * Two-factor side effects (mirrors eventa-api's `auth-two-factor` context):
 * consumes `identity.two_factor_disabled` and warns the member by email.
 */
@Module({
  providers: [TwoFactorDisabledHandler],
})
export class AuthTwoFactorModule {}
