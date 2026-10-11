import { inlineText } from './inline-text';

/**
 * The one guarantee: a value occupies its line and cannot leave it. Everything
 * below is a way for a string to end up on a second line, which is what makes
 * it a header in a subject and an extra sentence in a body.
 *
 * The invisible characters are built with {@link String.fromCodePoint} rather
 * than written as escapes: a literal U+2028 inside a regex or string literal IS
 * a line terminator, so a spec about line terminators cannot spell them out.
 */
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const NEXT_LINE = String.fromCodePoint(0x85);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_NO_BREAK_SPACE = String.fromCodePoint(0xfeff);

const LINE_BREAK = new RegExp(
  `[\r\n\v\f${NEXT_LINE}${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`,
  'u',
);

describe('inlineText, on everything that breaks a line', () => {
  it.each([
    ['a newline', 'Somchai' + '\n' + 'Subject: your account is locked'],
    ['a carriage return', 'Somchai' + '\r' + 'Subject: locked'],
    [
      'CRLF, as a mail client writes it',
      'Somchai' + '\r\n' + 'Bcc: a@evil.test',
    ],
    ['a vertical tab', 'Somchai' + '\v' + 'Subject: locked'],
    ['a form feed', 'Somchai' + '\f' + 'Subject: locked'],
    ['U+2028 LINE SEPARATOR', `Somchai${LINE_SEPARATOR}Subject: locked`],
    [
      'U+2029 PARAGRAPH SEPARATOR',
      `Somchai${PARAGRAPH_SEPARATOR}Subject: locked`,
    ],
    ['U+0085 NEXT LINE', `Somchai${NEXT_LINE}Subject: locked`],
  ])('flattens %s', (_what, raw) => {
    expect(inlineText(raw)).not.toMatch(LINE_BREAK);
    expect(inlineText(raw).split('\n')).toHaveLength(1);
  });

  it('leaves a single space where a run of breaks was', () => {
    expect(inlineText('Somchai\n\n\tJaidee')).toBe('Somchai Jaidee');
    expect(inlineText('  Somchai  ')).toBe('Somchai');
  });

  it('takes nothing invisible along', () => {
    // A zero-width pads a length check and renders as nothing; a bidi override
    // reverses the rest of the line it lands in, which is a lie about a line
    // the reader can see rather than one they cannot.
    expect(inlineText(`Som${ZERO_WIDTH_SPACE}chai`)).toBe('Som chai');
    expect(inlineText(`Somchai${RIGHT_TO_LEFT_OVERRIDE}Jaidee`)).toBe(
      'Somchai Jaidee',
    );
    expect(inlineText(`Somchai${ZERO_WIDTH_NO_BREAK_SPACE}`)).toBe('Somchai');
  });

  it('is nothing at all when the name was only invisible', () => {
    // `@IsNotEmpty()` upstream is satisfied by a lone zero-width, so this is
    // reachable, and `Hi ,` is the greeting it used to produce.
    expect(inlineText(ZERO_WIDTH_SPACE)).toBe('');
    expect(inlineText('   ')).toBe('');
  });
});

describe('inlineText, on the names it must not touch', () => {
  it.each([
    ['Thai, whose vowels and tones are combining marks', 'สมชาย ใจดี'],
    [
      'a long Thai rank and surname',
      'พลตำรวจเอก ประภัสสราภรณ์ ศรีวรรณวิทย์ไพศาล',
    ],
    ['a company, which is what a receipt is often billed to', 'Acme Co., Ltd.'],
    ['a name with a digit in it', 'Somchai 2'],
    ['an apostrophe and a hyphen', "Jean-Luc O'Brien"],
    ['a patronymic chain', 'Muhammad bin Abdullah bin Rashid Al Maktoum'],
    ['a middle dot, which separates Uyghur names', 'ئەخمەت·تۇرسۇن'],
  ])('keeps %s exactly', (_what, name) => {
    expect(inlineText(name)).toBe(name);
  });

  it('keeps prose, and that is the documented limit of this rule', () => {
    // It bounds STRUCTURE, not content. A lure survives, because the name is
    // the reader's own and the alternative — `safeDisplayName`'s allow-list —
    // declines the digits and commas a receipt legitimately carries. See the
    // module docstring for why that trade differs in a security notice.
    const lure = 'Somchai call 0812345678 now';
    expect(inlineText(lure)).toBe(lure);
  });
});
