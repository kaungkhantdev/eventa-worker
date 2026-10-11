import type { Locale } from '../../db/schema/events';
import { inlineText } from './inline-text';
import { asLocale } from './locale';

/**
 * The line that greets a reader by name, in their language — the one place in
 * this service that interpolates a person's name into copy.
 *
 * WHY IT IS SHARED, and this is the whole point of the file: there used to be
 * eight copies of it. Every attendee-facing notice module declared its own
 * `greeting: (name) => \`Hi ${name},\`` in its own `Copy` block, in both
 * languages, and every one of them interpolated the name RAW. That is sixteen
 * string literals saying the same thing and eight independent chances to
 * forget {@link inlineText} — and eight times out of eight it was forgotten,
 * because nothing about writing `Hi ${name},` suggests there is a rule to look
 * up. The rule cannot be remembered into existence at eight call sites. So the
 * greeting is not a thing a notice module writes any more: it asks for one.
 *
 * It takes RAW text and sanitises here rather than trusting its caller, for the
 * same reason — a caller that has to prepare the name first is a caller that
 * can forget to.
 *
 * NAMELESS WHEN THERE IS NO NAME, which is a product bug and not a security
 * one. A name consisting of one zero-width space satisfies eventa-api's
 * `@IsNotEmpty()` and is nothing at all once flattened, and `Hi ,` in
 * somebody's inbox is precisely the unfilled personalization field US-MSG-01
 * forbids. The Thai fallback drops the `คุณ` politeness particle with the name:
 * `สวัสดีคุณ` on its own reads "hello you", so it is `สวัสดี` — the same choice
 * `email-change.notice.ts` made for the identity notices.
 *
 * This greets; it never declines. A security notice needs the opposite — see
 * `inline-text.ts` for which rule a message wants and why they differ.
 */

/** One language's greeting, with a name and without one. */
interface GreetingCopy {
  named: (name: string) => string;
  nameless: string;
}

const COPY: Record<Locale, GreetingCopy> = {
  en: {
    named: (name) => `Hi ${name},`,
    nameless: 'Hi,',
  },
  th: {
    named: (name) => `สวัสดีคุณ ${name}`,
    nameless: 'สวัสดี',
  },
};

/**
 * `Hi Somchai,` / `สวัสดีคุณ สมชาย` — or the nameless form when the name holds
 * nothing printable.
 */
export function greeting(locale: Locale, name: string): string {
  // `asLocale`, not `COPY[locale]`. The static type is a claim about the wire,
  // and this service only MIRRORS eventa-api's enum: one `ALTER TYPE locale
  // ADD VALUE` upstream puts a string in a `Locale`-typed variable that is not
  // a `Locale`, and indexing with it read `undefined.named` and threw — before
  // the send, with no warn line and no counter, because a TypeError is not a
  // failed read. See `locale.ts`, which exists for that exact incident; eight
  // notices now funnel through here, so this is the place it must not recur.
  const t = COPY[asLocale(locale)];
  const inline = inlineText(name);
  return inline ? t.named(inline) : t.nameless;
}
