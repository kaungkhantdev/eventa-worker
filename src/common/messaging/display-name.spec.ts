import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_DISPLAY_NAME_WORDS,
  safeDisplayName,
} from './display-name';

describe('safeDisplayName', () => {
  it('leaves an ordinary name exactly as it is', () => {
    expect(safeDisplayName('Somchai Jaidee')).toBe('Somchai Jaidee');
  });

  it('leaves a Thai name alone', () => {
    expect(safeDisplayName('สมชาย ใจดี')).toBe('สมชาย ใจดี');
  });

  it('keeps an initial, which is a dot that is not a domain', () => {
    expect(safeDisplayName('Somchai J. Jaidee')).toBe('Somchai J. Jaidee');
  });

  /**
   * The floor. A newline in an interpolated name is a line the attacker writes
   * in somebody else's security mail, and a CR is header injection in a
   * subject.
   */
  it('collapses newlines and the whitespace around them', () => {
    expect(safeDisplayName('Somchai\r\n\tJaidee')).toBe('Somchai Jaidee');
    expect(safeDisplayName('  Somchai  ')).toBe('Somchai');
  });

  /**
   * Zero-width and bidi-override characters re-order what the reader sees.
   * Written as code points rather than pasted in, because a test for invisible
   * characters that contains invisible characters is unreviewable.
   */
  it('drops invisible and direction-overriding characters', () => {
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    const rightToLeftOverride = String.fromCodePoint(0x202e);

    const name = `Som${zeroWidthSpace}chai${rightToLeftOverride}Jaidee`;

    expect(safeDisplayName(name)).toBe('Som chai Jaidee');
  });

  /** U+2028 LINE SEPARATOR breaks a line too, and `[\r\n]` would miss it. */
  it('collapses a Unicode line separator, not just CR and LF', () => {
    const name = `Somchai${String.fromCodePoint(0x2028)}Jaidee`;

    expect(safeDisplayName(name)).toBe('Somchai Jaidee');
  });
});

/**
 * What a name may CONTAIN. The rule is an allow-list, so these are the cases
 * that say the allow-list is wide enough to greet real members with — every
 * one of them has to keep passing, or the fix has cost somebody their name.
 */
describe('safeDisplayName, on the punctuation real names carry', () => {
  it.each([
    ['Somchai Jaidee', 'the ordinary case'],
    ['Jean-Luc Picard', 'a hyphenated given name'],
    ['Siobhán O’Brien', 'a typographic apostrophe'],
    ["Siobhan O'Brien", 'an ASCII apostrophe'],
    ['Somchai J. Jaidee', 'an initial'],
    ['J. R. R. Jaidee', 'nothing but initials and a surname'],
    ['María del Carmen García Pérez', 'five words and four accents'],
    ['สมชาย ใจดี', 'Thai, whose vowels and tone marks are combining marks'],
    [
      'นางสาว ประภัสสราภรณ์ ศรีสุวรรณกุล',
      'a Thai honorific and a long Thai name',
    ],
    ['Ἀριστοτέλης', 'a script that is neither Thai nor Latin'],
  ])('greets %p by name — %s', (name) => {
    expect(safeDisplayName(name)).toBe(name);
  });

  /**
   * The cap is on the whole name, and a Thai name eats into it faster than a
   * Latin one: every vowel and tone mark is its own code point. A name at
   * exactly the cap is still a name.
   */
  it('greets a name of exactly the maximum length', () => {
    const atCap = 'ก'.repeat(MAX_DISPLAY_NAME_LENGTH);

    expect(safeDisplayName(atCap)).toBe(atCap);
  });

  it('greets a name of exactly the maximum number of words', () => {
    const atCap = Array.from(
      { length: MAX_DISPLAY_NAME_WORDS },
      () => 'Somchai',
    ).join(' ');

    expect(safeDisplayName(atCap)).toBe(atCap);
  });
});

/**
 * WHAT A NAME IS NOT. The deny-list this replaced caught `:`, `/` and a dotted
 * ASCII suffix, and nothing else — so sixty characters of attacker prose with
 * no URL punctuation in it reached the greeting verbatim, in mails whose own
 * docstrings say their no-link guarantee is ENFORCED. These are the strings
 * that got through, and the three shapes they exploited: a digit run, a
 * sentence, and a deny-list that dropped the bad word and greeted with the
 * rest.
 */
describe('safeDisplayName, on a name that is not one', () => {
  /**
   * A bare phone number is a link on a phone. iOS Mail and Gmail on Android
   * turn a run of digits in plain text into a `tel:` link with no scheme, no
   * slash and no dot to go on — so a digit is not a name character, and `+`
   * and `(` are not either.
   */
  it.each([
    'Somchai call 0812345678 now',
    'Support +66 81 234 5678',
    'Somchai 02-123-4567',
    'Line id somchai99',
  ])('declines %p, because a phone linkifies digits into tel:', (name) => {
    expect(safeDisplayName(name)).toBeNull();
  });

  /** A sentence is not a name, whatever characters it is spelt with. */
  it.each([
    'Ignore this, it was me, your admin',
    'Ignore this it was me your admin',
    'Please reply to this message with your password',
  ])('declines %p, because a greeting takes a name, not prose', (name) => {
    expect(safeDisplayName(name)).toBeNull();
  });

  /**
   * The mechanism, not just the symptom. The old rule DROPPED the link-shaped
   * run and greeted with whatever was left, which is how a hostile string was
   * edited into a plausible greeting: `Hi Somchai secure your account at,`.
   * Keeping part of a hostile name is what failed, so a name is now accepted
   * or declined whole.
   */
  it('declines the whole name rather than greeting with the rest of it', () => {
    expect(
      safeDisplayName(
        'Somchai\n\nURGENT: secure your account at https://acme-support.evil.test/fix',
      ),
    ).toBeNull();
    expect(safeDisplayName('Somchai www.evil.test')).toBeNull();
    expect(safeDisplayName('Somchai evil.test/fix')).toBeNull();
    expect(safeDisplayName('Somchai somchai@evil.test')).toBeNull();
  });

  /** A greeting is not a paragraph, whatever the API allows. */
  it('declines a name longer than the cap rather than truncating it', () => {
    expect(safeDisplayName('ก'.repeat(MAX_DISPLAY_NAME_LENGTH + 1))).toBeNull();
    expect(safeDisplayName('ก'.repeat(200))).toBeNull();
  });

  /**
   * The honest cost of the word cap, recorded rather than hidden: a long
   * patronymic chain is a real name and is declined. It costs that reader
   * `Hi,` — the same fallback a missing name already gets — and it is the
   * trade that stops the field carrying a sentence at all.
   */
  it('declines more words than a name has, including some real ones', () => {
    expect(
      safeDisplayName('Muhammad bin Abdullah bin Rashid Al Maktoum'),
    ).toBeNull();
  });

  /** Only nothing-left is null; the caller then greets without a name. */
  it('is null when nothing usable survives', () => {
    expect(safeDisplayName('https://evil.test/fix')).toBeNull();
    expect(safeDisplayName('   ')).toBeNull();
    expect(safeDisplayName('')).toBeNull();
  });
});

describe('names the rule used to decline', () => {
  /*
   * Whole-rejection means a declined name costs the WHOLE greeting, so a false
   * positive is not cosmetic: `Dr. Somchai Jaidee` was greeted `Hi,`, and an
   * organizer's invitation template rendered `Hi , you are invited`.
   *
   * Widening the abbreviation from one letter to four is safe because the dot
   * must be LAST — `evil.com` has letters after its dot and is still declined.
   */
  it.each([
    'Dr. Somchai Jaidee',
    'Martin Luther King Jr.',
    'Ann St. John',
    'Mrs. Jaidee',
    'Somchai J.',
  ])('greets %s', (name) => {
    expect(safeDisplayName(name)).toBe(name);
  });

  // U+00B7 separates Chinese and Uyghur transliterated names and Catalan l·l.
  // It is not a dot any URL parser accepts, so it costs nothing to allow.
  it.each(['迈克尔·乔丹', 'Abdul·Rahman'])('greets %s', (name) => {
    expect(safeDisplayName(name)).toBe(name);
  });

  // And the widening must not have opened a hostname.
  it.each(['evil.com', 'pay.me', 'a.co', 'eventa.support.test'])(
    'still declines %s',
    (host) => {
      expect(safeDisplayName(host)).toBeNull();
    },
  );
});
