/**
 * Who a non-production worker is allowed to email (`EMAIL_ALLOWLIST`).
 *
 * Seeded and copied-down data is full of real-looking addresses. Pointing a dev
 * box at a real SMTP provider — which is the only way to verify delivery
 * actually works — otherwise means one `confirm` away from mailing a stranger
 * whose address happens to be in the database.
 *
 * Pure functions, no I/O: this is the rule, and `GuardedEmailProvider` is the
 * thing that applies it.
 */

const SEPARATOR = ',';
/** An entry beginning with `@` permits a whole domain, e.g. `@eventa.co.th`. */
const DOMAIN_PREFIX = '@';

/** `"a@x.test, @y.test"` → `['a@x.test', '@y.test']`. Blank yields `[]`. */
export function parseAllowlist(raw: string): string[] {
  return raw
    .split(SEPARATOR)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * May this recipient be mailed?
 *
 * Production always says yes — the allowlist is a development guard, and
 * applying it to real attendees would be an outage dressed as a safety feature.
 * Everywhere else an empty list blocks everything, which is the safe direction:
 * a forgotten variable should read as "no mail went out", not as "mail went to
 * everyone".
 */
export function isDeliverable(
  recipient: string,
  allowlist: string[],
  isProduction: boolean,
): boolean {
  if (isProduction) return true;
  const address = recipient.trim().toLowerCase();
  return allowlist.some((entry) =>
    entry.startsWith(DOMAIN_PREFIX)
      ? address.endsWith(entry)
      : address === entry,
  );
}
