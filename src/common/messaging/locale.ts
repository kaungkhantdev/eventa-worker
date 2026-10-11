import { type Locale, localeEnum } from '../../db/schema/events';

/**
 * The language a message falls back to when nothing better is known.
 *
 * One definition, imported, rather than the four `const DEFAULT_LOCALE` copies
 * that had accumulated — in both notice repositories, in the email-change
 * handler and in the event-recipients repository. They all said `'en'`, so the
 * duplication cost nothing yet; it would have cost something the first time one
 * of them was changed alone.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Narrow a value from the database to a `Locale`, or fall back.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE COLUMN'S TYPE. `users.locale` and
 * `organizations.locale` are declared with `localeEnum()`, so Drizzle types
 * them `Locale` and every caller believes it. But this service only MIRRORS
 * that enum — eventa-api owns the type and its migrations — and Drizzle's enum
 * column defines no `mapFromDriverValue`, so whatever Postgres sends arrives
 * verbatim and keeps the static type regardless. One `ALTER TYPE locale ADD
 * VALUE` upstream therefore puts a string in a `Locale`-typed variable that is
 * not a `Locale`, and nothing between the socket and the copy table notices.
 *
 * What that cost: the bilingual notices index a `Record<Locale, Copy>` by this
 * value, so an unknown locale read `undefined.subject` and threw while building
 * the subject line — BEFORE the send, and with no warn line and no counter,
 * because it is a `TypeError` and not a failed read. The message rode the retry
 * ladder into the dead-letter queue, and the person whose second factor had
 * just been removed was told nothing. That is the precise failure the earlier
 * fix was meant to end, surviving in a second form: guarding how a read FAILS
 * does nothing about what it RETURNS.
 *
 * So this is the boundary where an untrusted value becomes a trusted one, in
 * the same spirit as the tolerant-reader zod schemas applied to every message:
 * the type is a claim about the wire, and the wire is checked.
 *
 * The accepted set is read from `localeEnum.enumValues` rather than re-typed,
 * so adding a language upstream and here needs no edit to this file.
 */
export function asLocale(value: unknown): Locale {
  return (localeEnum.enumValues as readonly string[]).includes(value as string)
    ? (value as Locale)
    : DEFAULT_LOCALE;
}
