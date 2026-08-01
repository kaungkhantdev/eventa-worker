import { Module } from '@nestjs/common';
import { EmailVerificationHandler } from './email-verification.handler';

/**
 * Sign-up side effects (mirrors eventa-api's `auth-signup` context): consumes
 * `identity.email_verification_requested` and delivers the confirmation email
 * (US-ACC-01) through the EmailProvider port (EmailModule). The link/token is
 * supplied by the API; this side only delivers it.
 */
@Module({
  providers: [EmailVerificationHandler],
})
export class AuthSignupModule {}
