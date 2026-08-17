import { isDeliverable, parseAllowlist } from './email-allowlist';

const LIST = parseAllowlist('me@eventa.test, @mycompany.co.th');

describe('parseAllowlist', () => {
  it('splits on commas and trims the whitespace people leave in .env', () => {
    expect(parseAllowlist(' a@x.test ,  b@y.test ')).toEqual([
      'a@x.test',
      'b@y.test',
    ]);
  });

  it('lower-cases entries so matching is case-insensitive', () => {
    expect(parseAllowlist('Me@Eventa.TEST')).toEqual(['me@eventa.test']);
  });

  it('is empty for an unset or blank value', () => {
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('  ,  ')).toEqual([]);
  });
});

describe('isDeliverable', () => {
  /**
   * Production delivers to whoever bought a ticket. The allowlist is a
   * development guard, and applying it to real attendees would be an outage
   * dressed up as a safety feature.
   */
  it('allows everyone in production, whatever the list says', () => {
    expect(isDeliverable('stranger@example.com', [], true)).toBe(true);
    expect(isDeliverable('stranger@example.com', LIST, true)).toBe(true);
  });

  it('allows an address on the list', () => {
    expect(isDeliverable('me@eventa.test', LIST, false)).toBe(true);
  });

  it('ignores case and surrounding whitespace on the recipient', () => {
    expect(isDeliverable('  ME@Eventa.test ', LIST, false)).toBe(true);
  });

  it('allows a whole domain when the entry starts with @', () => {
    expect(isDeliverable('anyone@mycompany.co.th', LIST, false)).toBe(true);
  });

  it('blocks an address that is on neither', () => {
    expect(isDeliverable('stranger@example.com', LIST, false)).toBe(false);
  });

  // A near-miss must not pass: `@mycompany.co.th` is not `@evil-mycompany.co.th`.
  it('matches a domain entry on the boundary, not as a substring', () => {
    expect(isDeliverable('x@evil-mycompany.co.th', LIST, false)).toBe(false);
  });

  /**
   * The safe default, and deliberately the strict one. A forgotten variable in
   * staging should mean "no mail went out" — visible, and fixed in a minute —
   * rather than "mail went to every seeded attendee", which nobody notices
   * until a stranger replies.
   */
  it('blocks everything outside production when the list is empty', () => {
    expect(isDeliverable('me@eventa.test', [], false)).toBe(false);
  });
});
