import { safeDisplayName } from '../../common/messaging/display-name';

/**
 * The name an invitation may greet by — `safeDisplayName`, plus the one bound
 * that rule cannot express.
 *
 * WHY THE SHARED RULE IS NOT ENOUGH HERE. `safeDisplayName` keeps prose out of
 * a greeting with a cap on WORDS, counted as `name.split(' ')`. Thai, Lao,
 * Khmer, Burmese, Chinese and Japanese put no space between words, so a
 * complete imperative is ONE word:
 *
 *     ด่วนบัญชีถูกแฮกโปรดโทรฝ่ายสนับสนุนทันทีเดี๋ยวนี้
 *
 * — "URGENT your account was hacked, call support now", 48 code points, no
 * digit, no punctuation, inside every shared cap. In the primary locale of a
 * Thai-market product, which is to say the defence was blind exactly where it
 * was needed most.
 *
 * WHY THIS MODULE AND NOT THE SHARED RULE. The security notices answered the
 * same finding by dropping the greeting altogether: their reader is the account
 * holder, the name tells them nothing they do not know, and removing the
 * position removed the problem. An invitation cannot copy that. It is addressed
 * to somebody who has never heard of this workspace, so an unnamed invitation
 * is both a worse product and a worse signal — and dropping the name only for
 * the scripts the word cap cannot read would single out Thai readers in a Thai
 * product. So the one caller that still has to print a name owns the extra
 * rule, and `display-name.ts` stays the shared floor it already is.
 *
 * AND THE OWNERSHIP IS REVERSED, which is why the floor has to be higher. In
 * the identity notices the name is the READER'S OWN, written through their own
 * session; a forgery in it is at least a forgery about themselves. Here an
 * ORGANIZER types it into a form, about somebody else, and Eventa mails it to
 * an address of the organizer's choosing. The reader has no account, no history
 * and no reason to doubt it.
 *
 * WHICH IS ALSO WHY THIS MODULE DOES NOT CALL `common/messaging/greeting.ts`,
 * and the next reader should not fold it in to remove the duplication. That
 * helper FLATTENS a name to one line and greets with whatever is left; it
 * never declines, because its callers' names are the reader's own — a buyer
 * greeted on their own receipt. Pointing the invitation at it would trade a
 * rule that refuses a hostname, a phone number and a sentence for one that
 * only refuses a line break, on the one mail in this service whose name field
 * a stranger has no way to judge. Two greetings, because there are two
 * questions.
 *
 * WHAT THIS RULE IS. A cap on each NAME ELEMENT — each single-spaced run of
 * the name — rather than on the name as a whole, applied only to the runs the
 * word cap cannot see inside. A Thai name reaches 42 code points across three
 * elements (`พลตำรวจเอก ประภัสสราภรณ์ ศรีวรรณวิทย์ไพศาล`) and must pass; 42
 * code points in ONE element is not a name anybody has. That difference is the
 * only thing here arithmetic can actually decide, so it is the only thing this
 * claims to decide.
 *
 * WHAT IT DOES NOT CATCH, stated plainly because the two attempts before this
 * one each shipped a docstring that claimed more than the code delivered, and
 * that is how both survived review:
 *
 * - **It bounds the quantity of such text, it does not classify it.** A real
 *   Thai surname is 17 code points and a terse Thai imperative —
 *   `บัญชีถูกแฮกโทรด่วน`, "account hacked, call urgently" — is 18. No cap can
 *   be set between them, so a short one still reaches the greeting. What the
 *   cap removes is the room for a fluent, complete, urgent sentence; what it
 *   leaves is a fragment.
 * - **A sentence an organizer splits across elements still passes.** Spaces
 *   read oddly in Thai but they read, and three name-sized runs are three
 *   name-sized runs. Only `safeDisplayName`'s 48-code-point whole-name cap
 *   bounds the total.
 * - **The script list is enumerated, so it has a tail.** Unicode has no "does
 *   this script separate words with spaces" property, so
 *   {@link SPACELESS_SCRIPT} names them. A spaceless script nobody listed
 *   falls back to the word cap and is therefore unbounded, exactly as Thai was
 *   before this file.
 * - **It is not the largest hole in this email, and does not pretend to be.**
 *   `payload.message` is the organizer's personal note, and US-REG-06 AC2 puts
 *   it verbatim at the very top of the mail — 250 characters of free text that
 *   may hold a phone number and a URL, which the name field may not. An
 *   organizer bent on phishing has a better slot than the greeting and always
 *   did. Closing that one is a product decision about what an invitation is,
 *   plus a charset on the API's `SendInviteDto`; it is not a longer rule here.
 *
 * What it costs: a name with one element longer than the cap is declined
 * WHOLE, as the shared rule declines whole, and the invitation greets without
 * a name. Keeping part of a name nobody wrote as a name is how the deny-list
 * this lineage replaced edited a hostile string into a plausible greeting.
 */

/**
 * How many code points one element of a name may hold, when the script gives
 * `split(' ')` nothing to count.
 *
 * Measured against real names rather than against the lure — a cap set to
 * exclude an attack is a cap that excludes somebody's surname next year. The
 * longest name element in evidence is `ศรีวรรณวิทย์ไพศาล`, 17 code points,
 * because every Thai vowel and tone mark is its own. Thailand's Person Name Act
 * caps a NEWLY registered surname at ten Thai letters, and ten letters with the
 * vowels and tones that write them come to roughly twenty code points — so 20
 * clears the evidence, leaves room for the longer compound surnames the Act
 * grandfathers, and still refuses the 48-code-point sentence in the finding.
 *
 * It is deliberately NOT derived from `MAX_DISPLAY_NAME_LENGTH`: that cap is
 * the length of a whole greeting's worth of name, and this is the length of one
 * part of one name. Tying them would mean a two-element Thai name could not use
 * the budget a three-element one gets.
 */
export const MAX_SPACELESS_NAME_ELEMENT = 20;

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
const SPACELESS_SCRIPT =
  /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Tai_Tham}]/u;

/**
 * What separates one element of a name from the next. A single space, because
 * `safeDisplayName` has already collapsed every whitespace class and every
 * invisible character into exactly that — which is why it runs first.
 */
const ELEMENT_SEPARATOR = ' ';

/**
 * The name to greet an invitee with, or null when the invitation should greet
 * without one. Never throws, and never withholds a mail: see the file
 * docstring for what it does and does not decide.
 */
export function invitationGreetingName(raw: string): string | null {
  const name = safeDisplayName(raw);
  if (name === null) return null;
  return name.split(ELEMENT_SEPARATOR).every(isNameElement) ? name : null;
}

/**
 * Whether one element is a name's worth of text.
 *
 * A run holding ANY spaceless-script character is measured whole: otherwise a
 * Latin prefix would buy the cap back, since `Anan` + a Thai sentence is still
 * one run with one space-delimited word in it.
 */
function isNameElement(element: string): boolean {
  if (!SPACELESS_SCRIPT.test(element)) return true;
  return Array.from(element).length <= MAX_SPACELESS_NAME_ELEMENT;
}
