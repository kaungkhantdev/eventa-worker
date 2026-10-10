import type { Locale } from '../../db/schema/events';
import { greeting } from './greeting';

describe('the greeting every attendee notice shares', () => {
  it('greets by name in the reader’s own language', () => {
    expect(greeting('en', 'Somchai')).toBe('Hi Somchai,');
    expect(greeting('th', 'สมชาย')).toBe('สวัสดีคุณ สมชาย');
  });

  it('adds no line, whatever the name tried to add', () => {
    const lure = 'Somchai\nSubject: Your Eventa account is locked';
    expect(greeting('en', lure).split('\n')).toHaveLength(1);
    expect(greeting('th', lure).split('\n')).toHaveLength(1);
  });

  it('greets without a name rather than greeting `Hi ,`', () => {
    // Reachable: a lone zero-width passes eventa-api's `@IsNotEmpty()` and is
    // nothing once flattened.
    expect(greeting('en', '​')).toBe('Hi,');
    expect(greeting('en', '   ')).toBe('Hi,');
  });

  it('drops the Thai politeness particle with the name', () => {
    // `สวัสดีคุณ` on its own reads "hello you"; the particle belongs to a name.
    expect(greeting('th', '')).toBe('สวัสดี');
    expect(greeting('th', '')).not.toContain('คุณ');
  });
});

/**
 * An unknown locale must not cost the reader their mail.
 *
 * `greeting` is the shared chokepoint eight notices now funnel through, and it
 * indexes `COPY[locale]` directly. `locale.ts` exists because exactly this
 * read threw once before: Drizzle's enum column defines no
 * `mapFromDriverValue`, so one `ALTER TYPE locale ADD VALUE` in eventa-api
 * puts a string in a `Locale`-typed variable that is not a `Locale`, and the
 * `TypeError` dead-lettered a security alert with no warn line and no counter.
 * Guarding one read and not the next leaves the same hole in a new place.
 */
describe('a locale this service has never heard of', () => {
  it('greets in the default language rather than throwing', () => {
    expect(() => greeting('ja' as Locale, 'Somchai')).not.toThrow();
    expect(greeting('ja' as Locale, 'Somchai')).toBe('Hi Somchai,');
  });

  /**
   * The fallback locale changes which copy table is read, nothing else: the
   * name is still flattened to one line. (Vetting a name's SHAPE is
   * `safeDisplayName`'s job and deliberately not this one — attendee mail
   * sanitises a self-owned name rather than declining it; see
   * `inline-text.ts`.)
   */
  it('still keeps the name to one line', () => {
    const hostile = 'Somchai' + String.fromCodePoint(0x0a) + 'URGENT: call us';

    expect(greeting('ja' as Locale, hostile).split('\n')).toHaveLength(1);
  });
});
