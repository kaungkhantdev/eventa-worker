import { Module } from '@nestjs/common';
import { AuthPasswordRepository } from './auth-password.repository';
import { PasswordChangedHandler } from './password-changed.handler';
import { PasswordResetHandler } from './password-reset.handler';

/**
 * Password side effects (mirrors eventa-api's `auth-password` context):
 *
 * - `identity.password_reset_requested` → the reset link (US-ACC-04);
 * - `identity.password_changed` → the "your password was changed" notice
 *   (US-ACC-05 / US-DISC-12 criterion 4), in the account holder's own
 *   language.
 *
 * Both deliver through the EmailProvider port (the global EmailModule); the
 * notice also reads a language through `AuthPasswordRepository` (the global
 * DatabaseModule), so this module imports neither.
 *
 * Providers are plain, but they are not optional: `ConsumerService` discovers
 * handlers through `DiscoveryService`, which walks PROVIDERS. A handler class
 * no module provides is never instantiated, never bound, and the topic
 * exchange discards every message for its routing key with no failure, no
 * retry and no dead-letter trace — which is why `app.module.spec.ts` asserts
 * each handler appears in this array specifically.
 */
@Module({
  providers: [
    AuthPasswordRepository,
    PasswordResetHandler,
    PasswordChangedHandler,
  ],
})
export class AuthPasswordModule {}
