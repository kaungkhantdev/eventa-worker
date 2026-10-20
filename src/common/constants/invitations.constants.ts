/** The invitations module's named constants. */

/**
 * How many LETTERS one element of a name may hold, when the script gives
 * `split(' ')` nothing to count.
 *
 * Letters, not code points. In Thai a code point is an artifact of the
 * encoding rather than a measure of the name: every vowel and tone mark is
 * its own, so two surnames of equal length differ by half depending on how
 * heavily they are marked — and the unit Thailand's Person Name Act legislates
 * in is letters. Counting code points penalised the marked names, and at 20 it
 * declined a real grandfathered surname and greeted that person "Hello,".
 *
 * Measured against real names rather than against the lure — a cap set to
 * exclude an attack is a cap that excludes somebody's surname next year:
 *
 *   ศรีวรรณวิทย์ไพศาล        17 code points, 14 letters  (longest in evidence)
 *   ศรีวรรณวิทย์ไพศาลมงคล    21 code points, 18 letters  (grandfathered compound)
 *   the 48-code-point lure   48 code points, 35 letters
 *
 * The Act caps a NEWLY registered surname at ten letters and grandfathers the
 * longer compounds, which reach 18 in evidence. 24 clears those with room and
 * still refuses a sentence at nearly twice that.
 *
 * It is deliberately NOT derived from `MAX_DISPLAY_NAME_LENGTH`: that cap is
 * the length of a whole greeting's worth of name, and this is the length of one
 * part of one name. Tying them would mean a two-element Thai name could not use
 * the budget a three-element one gets.
 */
export const MAX_SPACELESS_NAME_LETTERS = 24;

/**
 * Scripts written without spaces between words, so `split(' ')` cannot count
 * their words.
 *
 * Enumerated because Unicode has no property for it. The six languages named
 * in the finding give Thai, Lao, Khmer, Myanmar, Han (Chinese and Japanese
 * kanji) and the two Japanese syllabaries; Tai Tham is the Lanna script of
 * northern Thailand and belongs with them in this market. Hangul and the
 * abugidas of India are absent on purpose — modern Korean, Hindi and Bengali
 * all space their words, so the shared word cap already reads them.
 */
export const SPACELESS_SCRIPT =
  /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Tai_Tham}]/u;

/**
 * What separates one element of a name from the next. A single space, because
 * `safeDisplayName` has already collapsed every whitespace class and every
 * invisible character into exactly that — which is why it runs first.
 */
export const ELEMENT_SEPARATOR = ' ';

/** Unicode nonspacing marks — Thai vowel signs and tone marks among them. */
export const COMBINING_MARK = /\p{Mn}/u;

/**
 * What became of one invitation, for the single log line this handler writes.
 *
 * A named union rather than four bare strings: the line is what an operator
 * reads to find out why somebody was never invited, and a typo in it is a
 * question nobody can answer. `const enum` is not an option — `isolatedModules`
 * is on.
 */
export const OUTCOME = {
  sent: 'sent',
  noEvent: 'no-event',
  cancelled: 'event-cancelled',
  switchedOff: 'switched-off',
} as const;

/** Routing key eventa-api publishes when an organizer invites someone. */
export const INVITATION_SENT = 'invitation.sent';

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
export const FIRST_NAME_FIELD = 'first_name';

export const EVENT_NAME_FIELD = 'event_name';

/**
 * `{{ first_name }}`, in the spellings `merge-fields` accepts — braces, any
 * inner whitespace. Built from {@link FIRST_NAME_FIELD} rather than re-typed,
 * so the name of the field has one home.
 */
export const FIRST_NAME_PLACEHOLDER = new RegExp(
  `\\{\\{\\s*${FIRST_NAME_FIELD}\\s*\\}\\}`,
);
