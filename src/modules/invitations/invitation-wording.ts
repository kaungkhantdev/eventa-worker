import type { ChosenWording } from '../../common/messaging/merge-fields';
import { fill } from '../../common/messaging/merge-fields';

/**
 * The organizer's own subject and opening, merge-fields filled — or nulls
 * where their wording asked for something this invitation does not have.
 *
 * WHY THIS IS NOT JUST `fill`. The handler used to pass `first_name: name ??
 * ''`, so a name `invitationGreetingName` had declined reached the template as
 * the empty string and the organizer's wording rendered the hole where a name
 * belonged: a body of `Hi , you are invited to Bangkok Tech Week.` and a
 * subject of `, you're invited`. That is the one thing US-MSG-01 says a message
 * is never sent with — a personalization field left unfilled — and it arrived
 * looking like a bug in the organizer's template rather than in ours.
 *
 * `merge-fields.ts` is not the place to fix it. Empty-for-missing is deliberate
 * and documented there, and it is right for a field that is genuinely unknown:
 * a blank is better than literal braces in somebody's inbox, and the rule is
 * shared by every handler that renders a template. What is specific to the
 * invitation is the ANSWER to not having a name, and that answer is Eventa's
 * own copy, which has a nameless form in both languages.
 *
 * SO THE TWO PATHS AGREE. With no usable name the built-in greeting is
 * `Hello,` / `สวัสดี`; wording that asked for the name is dropped so the mail
 * falls back to exactly that, instead of printing an organizer's sentence with
 * a gap in it. The invitation is still SENT — a nameless invitation is a real
 * invitation, and an organizer's invitation vanishing because somebody typed a
 * phone number in the name box would be the worse failure.
 *
 * It is decided PER FIELD, like `pickWording` above it: an organizer whose
 * subject names the reader and whose body does not keeps the body.
 */

/**
 * The merge fields this message offers, per eventa-api's template catalog,
 * which refuses the rest on save.
 *
 * Module-private on purpose. The canonical home for these names is the
 * producer's catalog and there is no shared one here yet — eight handlers in
 * this service still spell them as bare literals — so naming them is a local
 * improvement, not a shared constant other modules should reach in for. If a
 * shared home is ever wanted it belongs beside `fill`, in `common/messaging`.
 */
const FIRST_NAME_FIELD = 'first_name';
const EVENT_NAME_FIELD = 'event_name';

/**
 * `{{ first_name }}`, in the spellings `merge-fields` accepts — braces, any
 * inner whitespace. Built from {@link FIRST_NAME_FIELD} rather than re-typed,
 * so the name of the field has one home.
 */
const FIRST_NAME_PLACEHOLDER = new RegExp(
  `\\{\\{\\s*${FIRST_NAME_FIELD}\\s*\\}\\}`,
);

export interface InvitationReader {
  /** Already through `invitationGreetingName`; null → no name to print. */
  name: string | null;
  eventName: string;
}

export function personalisedWording(
  chosen: ChosenWording,
  reader: InvitationReader,
): ChosenWording {
  const fields = {
    [FIRST_NAME_FIELD]: reader.name ?? '',
    [EVENT_NAME_FIELD]: reader.eventName,
  };
  return {
    subject: personalised(chosen.subject, reader.name, fields),
    body: personalised(chosen.body, reader.name, fields),
  };
}

/** One field, filled — or null, meaning "use Eventa's built-in copy". */
function personalised(
  text: string | null,
  name: string | null,
  fields: Record<string, string>,
): string | null {
  if (!text) return null;
  if (name === null && FIRST_NAME_PLACEHOLDER.test(text)) return null;
  return fill(text, fields);
}
