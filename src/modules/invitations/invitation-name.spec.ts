import {
  MAX_SPACELESS_NAME_ELEMENT,
  invitationGreetingName,
} from './invitation-name';

/**
 * The names this rule exists to keep. Every one of them has to go on passing:
 * the invitation is addressed to somebody who has never heard of this
 * workspace, so a declined name costs the greeting that makes it an
 * invitation rather than a circular.
 */
describe('invitationGreetingName, on names people really have', () => {
  it.each([
    ['สมชาย ใจดี', 'the ordinary Thai case'],
    [
      'พลตำรวจเอก ประภัสสราภรณ์ ศรีวรรณวิทย์ไพศาล',
      'a Thai rank, a long given name and a long surname — 42 code points',
    ],
    ['นางสาว ประภัสสราภรณ์ ศรีสุวรรณกุล', 'a Thai honorific'],
    ['ສົມຈິດ ວົງສະຫວັນ', 'Lao'],
    ['សុភា ចាន់', 'Khmer'],
    ['အောင်ဆန်း စုကြည်', 'Burmese'],
    ['田中 太郎', 'Japanese in kanji'],
    ['クリストファー ヤマダ', 'a transliterated name in katakana'],
    ['迈克尔·乔丹', 'Chinese, where U+00B7 separates the two halves'],
    ['Anan Suksawat', 'Latin, which this rule must not touch'],
    ['Dr. Somchai Jaidee', 'a title, which the shared rule already keeps'],
    ['María del Carmen García Pérez', 'five Latin words'],
  ])('greets %p by name — %s', (name) => {
    expect(invitationGreetingName(name)).toBe(name);
  });

  /**
   * The cap is per ELEMENT, not per name, which is the whole point: a Thai
   * name of three elements is 42 code points and must pass, while 42 code
   * points in ONE element is not a name anybody has.
   */
  it('greets a name element of exactly the maximum length', () => {
    const atCap = 'ก'.repeat(MAX_SPACELESS_NAME_ELEMENT);

    expect(invitationGreetingName(`${atCap} ${atCap}`)).toBe(
      `${atCap} ${atCap}`,
    );
  });
});

/**
 * THE FINDING. `safeDisplayName` bounds prose with `name.split(' ')`, and the
 * scripts below put no space between words — so a complete imperative is ONE
 * word, holds no digit and no URL punctuation, and clears every shared cap.
 */
describe('invitationGreetingName, on a sentence the word cap cannot see', () => {
  it('declines the Thai imperative that passed every shared cap', () => {
    // "URGENT your account was hacked, call support now" — 48 code points,
    // one word, no digits, no punctuation.
    const lure = 'ด่วนบัญชีถูกแฮกโปรดโทรฝ่ายสนับสนุนทันทีเดี๋ยวนี้';

    expect(Array.from(lure).length).toBe(48);
    expect(lure.split(' ')).toHaveLength(1);
    expect(invitationGreetingName(lure)).toBeNull();
  });

  it('declines one element longer than a name element, in every listed script', () => {
    const tooLong = (ch: string) => ch.repeat(MAX_SPACELESS_NAME_ELEMENT + 1);

    for (const ch of ['ก', 'ກ', 'ក', 'က', '中', 'あ', 'ア', 'ᨠ']) {
      expect(invitationGreetingName(tooLong(ch))).toBeNull();
    }
  });

  /**
   * A run is measured whole if ANY of it is unsegmentable, or else a Latin
   * prefix would buy an attacker the cap back: `Anan` + a sentence is one run.
   */
  it('measures a run that only partly uses such a script', () => {
    const run = `Anan${'ก'.repeat(MAX_SPACELESS_NAME_ELEMENT)}`;

    expect(invitationGreetingName(run)).toBeNull();
  });

  it('declines the whole name rather than the offending element', () => {
    // Keeping part of a name nobody wrote as a name is how the deny-list this
    // replaced edited a hostile string into a plausible greeting.
    const name = `สมชาย ${'ก'.repeat(MAX_SPACELESS_NAME_ELEMENT + 1)}`;

    expect(invitationGreetingName(name)).toBeNull();
  });
});

/**
 * THE HONEST LIMIT, pinned as a test rather than left to a docstring — the two
 * attempts before this one each claimed more than the code delivered, and that
 * is how both survived review.
 *
 * This rule bounds the QUANTITY of text the word cap cannot segment. It does
 * not classify it, and no length rule can: a real Thai surname is 17 code
 * points and a terse Thai imperative is 18. What follows therefore still
 * reaches the greeting, and saying so is the point.
 */
describe('invitationGreetingName, on what it does not catch', () => {
  it('still accepts a terse Thai imperative, because it is a name’s length', () => {
    // "account hacked, call urgently" — 18 code points, inside any cap a real
    // 17-code-point surname forces us to allow.
    const terse = 'บัญชีถูกแฮกโทรด่วน';

    expect(Array.from(terse).length).toBeLessThan(MAX_SPACELESS_NAME_ELEMENT);
    expect(invitationGreetingName(terse)).toBe(terse);
  });

  it('still accepts a sentence an organizer splits across elements', () => {
    // Spaces read oddly in Thai but read. The element cap bounds each run, so
    // a sentence broken into name-sized runs passes — only `safeDisplayName`'s
    // 48-code-point whole-name cap bounds the total.
    const split = 'ด่วนบัญชีถูกแฮก โปรดโทรฝ่าย สนับสนุนทันที';

    expect(invitationGreetingName(split)).toBe(split);
  });
});

/** Everything the shared rule declines stays declined; this only narrows. */
describe('invitationGreetingName, on what the shared rule already refused', () => {
  it.each([
    [
      'Anan\n\nRegister instead at https://evil.test/fix',
      'a newline and a URL',
    ],
    ['Support call 0812345678 now', 'a digit run, which is tel: on a phone'],
    ['Ignore this, it was me, your admin', 'Latin prose, caught by the words'],
    ['evil.test', 'a hostname'],
    ['   ', 'nothing at all'],
    ['', 'an empty string'],
  ])('declines %p — %s', (name) => {
    expect(invitationGreetingName(name)).toBeNull();
  });

  /**
   * Order matters: the shared rule runs FIRST, so an invisible character has
   * already become a real space by the time elements are measured. Breaking
   * the lure in half with one buys nothing — both halves are still longer
   * than a name element.
   */
  it('measures elements after the shared rule has collapsed the invisibles', () => {
    const lure = 'ด่วนบัญชีถูกแฮกโปรดโทรฝ่ายสนับสนุนทันทีเดี๋ยวนี้';
    const points = Array.from(lure);
    const halved = [
      ...points.slice(0, points.length / 2),
      String.fromCodePoint(0x200b),
      ...points.slice(points.length / 2),
    ].join('');

    expect(invitationGreetingName(halved)).toBeNull();
  });
});
