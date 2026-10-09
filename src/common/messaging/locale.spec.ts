import { localeEnum } from '../../db/schema/events';
import { DEFAULT_LOCALE, asLocale } from './locale';

describe('asLocale', () => {
  it('passes through every value the locale enum declares', () => {
    for (const value of localeEnum.enumValues) {
      expect(asLocale(value)).toBe(value);
    }
  });

  /*
   * The case that dead-lettered a security alert. eventa-api owns the `locale`
   * pgEnum and this service only mirrors it, so one ALTER TYPE upstream can put
   * a value on the wire that this mirror has never heard of. Drizzle's enum
   * column has no `mapFromDriverValue`, so the string arrives verbatim, typed
   * as a `Locale` it is not — and the copy table it then indexes returns
   * undefined, which throws while building the subject line, BEFORE the send.
   */
  it('coerces a value the mirror has never heard of to the default', () => {
    expect(asLocale('ja')).toBe(DEFAULT_LOCALE);
  });

  it.each([null, undefined, 42, '', 'EN', ' th '])(
    'coerces %p to the default rather than trusting the column type',
    (value) => {
      expect(asLocale(value)).toBe(DEFAULT_LOCALE);
    },
  );

  // Derived, not re-typed: adding a locale upstream must not need an edit here.
  it('accepts exactly the enum, so the set cannot drift from the schema', () => {
    expect(localeEnum.enumValues).toContain(DEFAULT_LOCALE);
  });
});
