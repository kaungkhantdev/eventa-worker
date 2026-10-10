/**
 * Free text somebody else wrote, made safe to interpolate into a line of copy.
 *
 * WHY THIS EXISTS. Every message this service sends is assembled by joining
 * lines with `\n`, and most of those lines interpolate text this service did
 * not write — the buyer's name, the event's name, the organizer's cancellation
 * reason. None of those fields is constrained upstream:
 * eventa-api's `BuyerDto.name` is `@IsString() @IsNotEmpty() @MaxLength(120)`,
 * `CreateEventDto.name` is `@MinLength(3) @MaxLength(120)`, and
 * `CancelEventDto.reason` is `@MaxLength(500)` — no charset, no newline
 * restriction on any of them. So a value carrying `\n` does not fill its place
 * in a message; it **adds a line of its own** to one, in Eventa's voice:
 *
 *     Hi Somchai
 *     Subject: Your Eventa account is locked, call 0812345678
 *     ,
 *
 * and in a SUBJECT the same value produces a second header line.
 *
 * WHY A SECOND FUNCTION, next to {@link safeDisplayName}. Because for a while
 * this module exported only a door that could say NO. `safeDisplayName` is an
 * allow-list: it returns null for anything not shaped like a name, and the
 * caller then greets nobody. That is the right answer for the identity notices
 * — a password-change alert loses nothing by not naming its reader, and the
 * name there was typed by whoever holds the session the alert is reporting.
 *
 * It is the wrong answer for a receipt. Eleven-odd attendee notices did not
 * call it, and the reason they did not is visible in what it declines: a digit
 * anywhere (`Somchai 2`), a comma (`Acme Co., Ltd.` — a buyer name on a tax
 * receipt is very often a company), more than five space-separated words, more
 * than 48 code points. A ticket confirmation greeting `Hi,` because somebody's
 * name has a number in it is a worse product than the lure it would be
 * avoiding, so those notices interpolated raw instead, and the boundary existed
 * only where it happened to be cheap. The sanitising half was in this module
 * the whole time — it was `collapsed()`, private, the first step of
 * `safeDisplayName`. There was no door marked "keep the name, just make it
 * safe". This is that door.
 *
 * WHICH ONE DO I WANT? Ask what the message is:
 *
 * - **A warning about somebody's account** (password changed, two-factor
 *   disabled, account closing, email changed) — {@link safeDisplayName}, and
 *   greet nobody when it returns null. The name there is attacker-controlled by
 *   definition and the copy claims to contain no links, so a plausible sentence
 *   in the greeting is the whole attack. See `display-name.ts`.
 * - **Anything else** — this. The name is the reader's own
 *   (`orders.buyer_name` for the address being mailed), there is no claim for a
 *   lure to borrow, and the greeting is part of the product.
 *
 * WHAT THIS GUARANTEES, exactly: the result occupies ONE line and holds nothing
 * invisible. No line break of any kind — not `\n`, not `\r`, not U+2028, not a
 * run of them — and no control or format character, so no zero-width joiner
 * padding a length check and no bidi override silently reversing the rest of
 * the line it lands in.
 *
 * WHAT IT DOES NOT, recorded rather than hidden: it does not stop prose.
 * `Hi Somchai call 0812345678 now,` passes, because every character in it is
 * one a name may contain. That is accepted HERE and refused in a security
 * notice, and the difference is not the character set — it is who owns the
 * name and what the surrounding copy claims:
 *
 * - The name is the READER'S OWN. `recipient.name` is
 *   `max(orders.buyer_name)` for the very address the message is going to, so
 *   somebody typing a lure into it is phishing themselves. The identity
 *   notices face the opposite case — whoever stole the session set the name,
 *   and the mail goes to the victim.
 * - These messages make no claim a lure can borrow. A receipt does not tell
 *   its reader it contains no links; it contains the organizer's own template
 *   body, the event's name and a payment link by design. A sentence smuggled
 *   into the greeting is not the weak link in a message already full of
 *   somebody else's words.
 *
 * So the rule here bounds STRUCTURE, not content: a value may say what it
 * likes inside its own line, and may not leave it.
 *
 * WHERE THAT RULE IS APPLIED, stated precisely because the first version of
 * this docstring claimed it uniformly and was wrong. It holds for every
 * SUBJECT without exception — a second line there is a second header — and for
 * every single-value field interpolated into a body: the greeting name, the
 * event's name, the place, the seller and its tax id, a line item. It does NOT
 * hold for the organizer's own free-text BLOCKS — a reminder's `opening`, a
 * template `body`, a seller's postal `address` — which are several lines by
 * design and would be mangled by flattening. Those are the organizer's layout,
 * not a value smuggled into someone else's line.
 *
 * And it is applied by each call site, not enforced: nothing makes a newly
 * written notice fail if it interpolates a borrowed value raw. That gap is
 * real — `invitationSubject` was the one subject builder of twelve that missed
 * it, and `reminderBody` flattened the name while leaving the event name and
 * the place open, both found only by measuring every field rather than reading
 * the list. A branded `InlineText` type that `EmailMessage.subject` required
 * would turn the omission into a compile error; until then the specs carry it,
 * so a notice's spec is where the next one gets caught.
 *
 * NOT A SUBSTITUTE FOR THE TRANSPORT BEHAVING, and not a bet on it either.
 * nodemailer does fold a subject's line breaks into spaces before writing the
 * header, so the live SMTP path is not injecting headers today — but
 * `EmailProvider` is an abstraction with three implementations here and a real
 * SES provider promised, and a boundary that holds only because of one
 * library's internals is not a boundary. The subject is made safe where it is
 * composed, which is also the only place that can know a line break there was
 * never wanted in the first place.
 */

/**
 * Control and format characters: every line break C0 and C1 defines, plus the
 * zero-widths and the bidi overrides. Replaced with a space rather than
 * deleted, so a zero-width between two letters cannot glue them into one
 * word that nobody wrote.
 */
const CONTROL_AND_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/**
 * Every whitespace class, not just `\r` and `\n`. `\s` under `u` covers
 * U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR and U+00A0 NO-BREAK SPACE,
 * all of which break or stretch a line in a mail client.
 */
const WHITESPACE_RUN = /\s+/gu;

/**
 * The text, on one line, with nothing invisible left in it.
 *
 * Deliberately NOT length-capped. eventa-api already bounds every field that
 * reaches here — 120 characters for a name or an event's name, 500 for a
 * cancellation reason — and the only thing a cap would add is a truncated Thai
 * surname, the mistake `MAX_DISPLAY_NAME_WORDS` records paying for in the
 * security notices. Once a value cannot leave its line, its length is a layout
 * question and not a safety one.
 */
export function inlineText(raw: string): string {
  return raw
    .replace(CONTROL_AND_FORMAT, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}
