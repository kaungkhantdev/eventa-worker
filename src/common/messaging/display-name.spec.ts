import { MAX_DISPLAY_NAME_LENGTH, safeDisplayName } from './display-name';

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

  /**
   * A greeting takes a person's name, and nothing that could be a link is one.
   * These mails say they contain no links, and most clients auto-linkify a bare
   * host in plain text — so a run with a scheme, a slash or a dotted TLD goes.
   */
  it('drops any run that could be read as a link', () => {
    expect(
      safeDisplayName(
        'Somchai\n\nURGENT: secure your account at https://acme-support.evil.test/fix',
      ),
    ).toBe('Somchai secure your account at');
    expect(safeDisplayName('Somchai www.evil.test')).toBe('Somchai');
    expect(safeDisplayName('Somchai evil.test/fix')).toBe('Somchai');
  });

  /** A greeting is not a place for a paragraph, whatever the API allows. */
  it('caps the length well short of what eventa-api accepts', () => {
    const long = 'ก'.repeat(200);

    expect(Array.from(safeDisplayName(long) ?? '')).toHaveLength(
      MAX_DISPLAY_NAME_LENGTH,
    );
  });

  /** Only nothing-left is null; the caller then greets without a name. */
  it('is null when nothing usable survives', () => {
    expect(safeDisplayName('https://evil.test/fix')).toBeNull();
    expect(safeDisplayName('   ')).toBeNull();
    expect(safeDisplayName('')).toBeNull();
  });
});
