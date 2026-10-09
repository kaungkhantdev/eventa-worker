/**
 * A person's name, made safe to interpolate into a plain-text message.
 *
 * WHY THIS EXISTS. `payload.name` reaches the identity notices straight off the
 * wire, and it is the one attacker-controlled string in mail that warns people
 * about attackers: eventa-api's `UpdateProfileDto.name` is `@IsString()
 * @MaxLength(200)` with no charset and no newline restriction, and the session
 * that can set it is the stolen one the two-factor, account-closure and
 * email-change notices exist to report. Interpolated verbatim, a profile named
 *
 *     Somchai\n\nURGENT: secure your account at https://evil.test/fix
 *
 * writes an attacker's own line ABOVE the warning, in mails that tell the
 * reader they contain no links, and most clients turn a bare host in plain text
 * into a clickable one. That is the phishing lure the notices were written to
 * warn against, delivered by Eventa, in Eventa's voice.
 *
 * WHAT IT DOES, AND WHY THAT MUCH.
 *
 * - **Collapses every line break and whitespace run to one space.** The floor:
 *   in a body a newline is a line the attacker writes, and in a SUBJECT it is
 *   header injection. It works off the whitespace and control CLASSES rather
 *   than `\r` and `\n`, because U+2028, U+0085 and friends break lines too.
 * - **Removes control and format characters** (`\p{Cc}`, `\p{Cf}`) — zero-width
 *   joiners and the bidi overrides that re-order what the reader sees. Replaced
 *   with a space rather than deleted, so nothing is silently glued together.
 * - **Drops any run that could be read as a link.** A greeting has no use for
 *   `:`, `/`, or a dotted ASCII suffix; those are what a client linkifies.
 * - **Caps the length.** A greeting is not a paragraph, whatever the API
 *   accepts, and a 200-character "name" is a smuggled message either way.
 *
 * A name is NOT escaped or rejected — these are security notices, and a notice
 * withheld or mangled into unreadability over a hostile profile name is the
 * same harm as one never sent. Stripping degrades; it never fails.
 *
 * Shared because all three identity notices greet by name and face exactly the
 * same wire field. Unlike the locale reads in those modules, this really is one
 * question with one answer.
 */

/**
 * Anything that could make the run look like a link to a mail client. A
 * personal name contains none of these; `Somchai J.` survives because a single
 * letter after the dot is not a TLD, while `evil.test`, `www.evil.test` and
 * `https://evil.test/fix` do not.
 *
 * It over-matches on purpose: a real surname written `St.John` is dropped from
 * the greeting too. That trade is deliberate and goes the safe way round — the
 * cost of a false positive is a greeting reading `Hi Ann,` instead of
 * `Hi Ann St.John,`, and the cost of a false negative is a clickable
 * attacker-chosen host in a security alert.
 */
const LINK_SHAPED = /[:/]|\.[A-Za-z]{2,}/u;

/** Control and format characters — line breaks, zero-widths, bidi overrides. */
const CONTROL_AND_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/** Every whitespace class, not just `\r` and `\n`; U+2028 breaks lines too. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * How much of a name a greeting prints. Generous for a real name (eventa-api
 * allows 200) and far too short to hide a sentence in.
 */
export const MAX_DISPLAY_NAME_LENGTH = 60;

/**
 * The name to greet with, or null when nothing usable is left — the caller then
 * greets without one. A mail addressed to exactly one mailbox loses very little
 * by not naming its reader, and nothing about the warning depends on it.
 */
export function safeDisplayName(raw: string): string | null {
  const words = collapsed(raw).split(' ').filter(isNameLike);
  const name = truncated(words.join(' ')).trim();
  return name.length > 0 ? name : null;
}

/** One line, single-spaced, with nothing invisible left in it. */
function collapsed(raw: string): string {
  return raw
    .replace(CONTROL_AND_FORMAT, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

function isNameLike(word: string): boolean {
  return word.length > 0 && !LINK_SHAPED.test(word);
}

/** By code point, so a cap never splits a surrogate pair in half. */
function truncated(name: string): string {
  const points = Array.from(name);
  return points.length > MAX_DISPLAY_NAME_LENGTH
    ? points.slice(0, MAX_DISPLAY_NAME_LENGTH).join('')
    : name;
}
