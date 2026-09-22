import type { Env } from '../../config/env.validation';

/** The transports this worker can text through. */
export type SmsTransport = NonNullable<Env['SMS_PROVIDER']>;

/**
 * What an unset `SMS_PROVIDER` means, decided in one place.
 *
 * `EMAIL_PROVIDER` can afford a single default because every deployment has
 * somewhere to send mail. SMS does not: there is no account for this product
 * yet, so the two environments want opposite things from "nothing configured".
 *
 * - A DEV BOX wants `log` — the whole path runs (the number is normalised, the
 *   channel switch is read, the delivery row is written) with no account, no
 *   cost, and no way to text a real attendee.
 * - PRODUCTION wants `off`. `log` there would write "sent" rows for texts that
 *   never left, and an organizer reading the delivery log would be told a
 *   text was delivered that nobody sent. Refusing to boot — the way a `log`
 *   EMAIL_PROVIDER is refused — is not an option while no SMS account exists
 *   to configure: it would take email down over a channel nobody is owed yet.
 *
 * A pure function so both branches are testable without an environment.
 */
export function resolveSmsTransport(
  env: Pick<Env, 'SMS_PROVIDER' | 'NODE_ENV'>,
): SmsTransport {
  if (env.SMS_PROVIDER) return env.SMS_PROVIDER;
  return env.NODE_ENV === 'production' ? 'off' : 'log';
}
