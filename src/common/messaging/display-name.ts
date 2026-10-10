import { inlineText } from './inline-text';

/**
 * A person's name, made safe to interpolate into a SECURITY notice — the
 * stricter of this module's two rules for a name.
 *
 * WHICH RULE DOES MY NOTICE WANT? This one only if the message is a warning
 * about somebody's account, because only there is the name attacker-controlled
 * by definition and only there does the copy make a claim ("this mail contains
 * no links") that a plausible sentence in the greeting can borrow. It is an
 * allow-list and it says NO: `Somchai 2`, `Acme Co., Ltd.` and a six-word
 * patronymic chain are all declined, and the caller greets nobody.
 *
 * Everything else — a receipt, a ticket confirmation, a reminder, a
 * cancellation — wants `inlineText` from `inline-text.ts`, which keeps the
 * name and only flattens it. Greeting `Hi,` on a ticket because somebody's
 * name has a digit in it is a worse product than the self-targeted lure it
 * would be avoiding; `inline-text.ts` carries that argument in full, and
 * `greeting.ts` is where an attendee notice gets its greeting from.
 *
 * Both rules begin with the same flattening step, and there is one copy of it:
 * {@link inlineText}.
 *
 * WHY THIS EXISTS. `payload.name` reaches the identity notices straight off the
 * wire, and it is the one attacker-controlled string in mail that warns people
 * about attackers: eventa-api's `UpdateProfileDto.name` is `@IsString()
 * @MaxLength(200)` with no charset and no newline restriction, and the session
 * that can set it is the stolen one the two-factor, password-change,
 * account-closure and email-change notices exist to report. Interpolated
 * verbatim, a profile named
 *
 *     Somchai\n\nURGENT: secure your account at https://evil.test/fix
 *
 * writes an attacker's own line ABOVE the warning, in mails that tell the
 * reader they contain no links. That is the phishing lure the notices were
 * written to warn against, delivered by Eventa, in Eventa's voice.
 *
 * WHY IT IS AN ALLOW-LIST. Because the deny-list that came first was not one
 * rule but an endless list of them, and it was short by exactly the attacks
 * nobody had thought of yet. It stripped line breaks and dropped runs holding
 * `:`, `/` or a dotted ASCII suffix — and so these reached the greeting
 * verbatim, within a 60-character cap, with no URL punctuation to catch:
 *
 *     Hi Ignore this, it was me, your admin,
 *     Hi Somchai call 0812345678 now,
 *     Hi Support +66 81 234 5678,
 *
 * The line count was unchanged and the mail held no URL, so both of the old
 * guarantees held — and the notice still shipped a tappable link, because **a
 * bare phone number is a link on a phone**: iOS Mail and Gmail on Android
 * linkify a run of digits into `tel:` with no scheme, slash or dot to go on.
 * The deny-list had to predict every shape a client linkifies; the allow-list
 * only has to say what a name is. A new idea about what a lure looks like
 * cannot get through a rule that was never asking.
 *
 * WHAT A NAME MAY CONTAIN, then — letters, the combining marks that write Thai
 * vowels and tones, a hyphen or apostrophe inside a word, and an initial's dot.
 * Not a digit. Not `@`, `+`, `(`, a comma or a colon. Words are separated by
 * single spaces and there are at most {@link MAX_DISPLAY_NAME_WORDS} of them.
 *
 * ACCEPTED OR DECLINED WHOLE, which is the other half of the fix. The old rule
 * dropped the offending RUN and greeted with the remainder, and that is how a
 * hostile string was edited into a plausible greeting: `Somchai\n\nURGENT:
 * secure your account at https://…` came out as `Hi Somchai secure your account
 * at,`. Keeping part of a name nobody wrote as a name is worse than keeping
 * none of it, so a name that is not name-shaped yields null and the notice
 * greets without one.
 *
 * WHAT THIS STILL CANNOT DO, recorded rather than hidden. `Hi Eventa Security,`
 * is two letter-words and passes, because it is indistinguishable from somebody
 * actually called that. The cap on words bounds the field to a name's worth of
 * text and keeps a sentence out of it, but no charset rule can stop a
 * three-word claim, and tightening until it could would greet real members as
 * strangers. The remedy for that one is not a longer rule here: it is for a
 * security notice not to print free text the reported session controls — a
 * change to the copy and the contract, the same shape as the missing
 * `workspaceName` recorded in `password-changed.notice.ts`.
 *
 * A name is NOT escaped or rejected upstream — these are security notices, and
 * a notice withheld over a hostile profile name is the same harm as one never
 * sent. This declines a name; it never fails a mail.
 *
 * Shared because every identity notice greets by name and faces exactly the
 * same wire field. Unlike the locale reads in those modules, this really is one
 * question with one answer.
 */

/**
 * One word of a name: a letter, then letters, combining marks, hyphens and
 * apostrophes, ending on a letter or a mark.
 *
 * It must OPEN with `\p{L}` so a leading combining mark — which renders on
 * whatever precedes it — cannot start a word, and close on `\p{L}` or `\p{M}`
 * so `O'` and `Jean-` are not words either. The mark class is not optional
 * polish: Thai writes its vowels and tones as `\p{Mn}`, so `ใจดี` fails a
 * letters-only rule and every Thai reader loses their name.
 */
const NAME_WORD = /^\p{L}(?:[\p{L}\p{M}'’·-]*[\p{L}\p{M}])?$/u;

/**
 * An abbreviation a name really carries: `J.`, `Dr.`, `Jr.`, `St.`, `Mrs.`.
 *
 * The dot must be LAST, which is what keeps a hostname out — `evil.com` has
 * letters after its dot and is not this shape, so widening from one letter to
 * four costs nothing. One letter alone was too tight: it declined every title
 * and suffix a real name carries, and because the rule rejects a name WHOLE,
 * `Dr. Somchai Jaidee` lost its greeting entirely rather than its title.
 */
const INITIAL = /^\p{L}{1,4}\.$/u;

/**
 * How long a name a greeting prints, in code points.
 *
 * Measured against the longest name this market really has rather than guessed:
 * a Thai rank, a long given name and a long surname — `พลตำรวจเอก
 * ประภัสสราภรณ์ ศรีวรรณวิทย์ไพศาล` — is 42 code points, because every vowel and
 * tone mark is its own. 48 clears that with room and is nowhere near the 200
 * eventa-api accepts. A tighter cap would be cheap for Latin names and would
 * quietly cost Thai ones their surname.
 */
export const MAX_DISPLAY_NAME_LENGTH = 48;

/**
 * How many words a name has. Five fits `María del Carmen García Pérez` and a
 * Thai honorific before a given name and a surname; a sixth word is prose, and
 * prose in a greeting is somebody else's sentence in Eventa's voice.
 *
 * **It bounds prose only in scripts that put spaces between words, and that
 * limit is the reason the security notices no longer greet by name at all.**
 * `name.split(' ')` counts ONE word for Thai, Japanese, Chinese, Lao, Khmer
 * and Burmese, so a 48-code-point Thai imperative clears this cap and the
 * length cap together. No cap can fix it: a real Thai name
 * (`พลตำรวจเอก ประภัสสราภรณ์ ศรีวรรณวิทย์ไพศาล`, 42) is longer than a usable
 * lure. What this rule DOES guarantee — proved by an exhaustive sweep of every
 * code point — is that no output carries a line break, a digit, a colon, a
 * slash, an `@` or a `+`, so nothing here becomes a link or a header.
 *
 * It costs a long patronymic chain its greeting, which is the honest price of
 * the rule and is paid in the documented fallback — `Hi,` — never in a mail.
 */
export const MAX_DISPLAY_NAME_WORDS = 5;

/**
 * The name to greet with, or null when it is not a name — the caller then
 * greets without one. A mail addressed to exactly one mailbox loses very little
 * by not naming its reader, and nothing about the warning depends on it.
 */
export function safeDisplayName(raw: string): string | null {
  // The flattening step is shared rather than repeated: it used to live here
  // as a private `collapsed()`, which is how eleven attendee notices came to
  // interpolate names raw — the only door this module exported was one that
  // could decline a name, and nothing offered to merely make one safe.
  const name = inlineText(raw);
  return isNameShaped(name) ? name : null;
}

/** A name's worth of words, each of them name-shaped, and nothing longer. */
function isNameShaped(name: string): boolean {
  const words = name.split(' ');
  return (
    name.length > 0 &&
    words.length <= MAX_DISPLAY_NAME_WORDS &&
    Array.from(name).length <= MAX_DISPLAY_NAME_LENGTH &&
    words.every(isNameWord)
  );
}

function isNameWord(word: string): boolean {
  return NAME_WORD.test(word) || INITIAL.test(word);
}
