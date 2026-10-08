import { Module } from '@nestjs/common';
import { PasswordResetHandler } from './password-reset.handler';

/**
 * Password side effects (mirrors eventa-api's `auth-password` context): consumes
 * `identity.password_reset_requested` and delivers the reset link (US-ACC-04)
 * through the EmailProvider port (EmailModule).
 */
@Module({
  providers: [PasswordResetHandler],
})
export class AuthPasswordModule {}
