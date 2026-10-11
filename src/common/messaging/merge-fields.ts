import type { Locale } from '../../db/schema/events';
import { inlineText } from './inline-text';
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
 *
 * EVERY SUBSTITUTED VALUE IS FLATTENED to one line ({@link inlineText}),
 * whichever field it is and whoever typed it. This is the one place that can
 * make that stick, because it is the substitution itself rather than a call
 * site somebody has to remember — and the values are not only names. A
 * template is filled with `first_name` (the buyer's, up to 120 characters of
 * anything), `event_name` (the organizer's, same), `ticket_type` and `reason`
 * (`CancelEventDto.reason`, `@MaxLength(500)`, no charset rule). The SAME
 * filled string is then used as the mail's SUBJECT and as its opening, so a
 * line break in any one of them is a second header line, which is indefensible
 * regardless of which field carried it.
 *
 * The cost is that a reason an organizer typed across two paragraphs arrives as
 * one. That is the right trade for a MERGE FIELD, which is a value dropped into
 * the middle of somebody's sentence and not a block of its own — and where the
 * reason gets a line to itself, in Eventa's own cancellation copy, its line
 * breaks survive.
 */
export function fill(text: string, fields: Record<string, string>): string {
  return text.replace(FIELD, (_, name: string) => {
    const value = fields[name];
    return value === undefined ? '' : inlineText(value);
  });
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
