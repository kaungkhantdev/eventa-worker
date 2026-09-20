import type { Locale } from '../../db/schema/events';
import type { TemplateWording } from './message-templates.repository';

/** `{{ first_name }}` — whitespace inside the braces is what people type. */
const FIELD = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Substitute an organizer's merge fields (US-MSG-02).
 *
 * A field with nothing behind it becomes EMPTY, never the literal braces.
 * US-MSG-01 is explicit that a message is never sent with a personalization
 * field left unfilled, and `Hi {{nickname}},` arriving in somebody's inbox is
 * precisely that. eventa-api refuses unknown fields on save, so this is the
 * second line of defence rather than the first.
 */
export function fill(text: string, fields: Record<string, string>): string {
  return text.replace(FIELD, (_, name: string) => fields[name] ?? '');
}

export interface ChosenWording {
  /** Null where the organizer wrote nothing — use the built-in copy. */
  subject: string | null;
  body: string | null;
}

/**
 * The organizer's wording for one reader, or nulls where they wrote none.
 *
 * Chosen per LANGUAGE and then per FIELD. A Thai reader does not get the
 * English an organizer happened to write — they get Eventa's Thai, which is
 * the better of the two wrong-ish answers — and a row with a body but no
 * subject falls back on the subject alone rather than sending a blank one.
 */
export function pickWording(
  wording: TemplateWording,
  locale: Locale,
): ChosenWording {
  return locale === 'th'
    ? { subject: wording.subjectTh, body: wording.bodyTh }
    : { subject: wording.subjectEn, body: wording.bodyEn };
}
