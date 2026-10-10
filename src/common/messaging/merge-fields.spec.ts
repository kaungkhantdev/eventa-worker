import { fill, pickWording } from './merge-fields';

describe('filling an organizer’s wording (US-MSG-02)', () => {
  const fields = { first_name: 'Anong', event_name: 'Tech Summit 2026' };

  it('puts the values where the fields were', () => {
    expect(fill('Hi {{first_name}}, {{event_name}} is on', fields)).toBe(
      'Hi Anong, Tech Summit 2026 is on',
    );
  });

  it('fills every occurrence, not just the first', () => {
    expect(fill('{{first_name}} {{first_name}}', fields)).toBe('Anong Anong');
  });

  it('accepts the spacing people actually type', () => {
    expect(fill('Hi {{ first_name }}', fields)).toBe('Hi Anong');
  });

  it('leaves a field it cannot fill EMPTY rather than as braces', () => {
    // US-MSG-01 is explicit that a message is never sent with a field left
    // unfilled. Literal `{{venue}}` in somebody's inbox is exactly that.
    expect(fill('See you at {{venue}}.', fields)).toBe('See you at .');
  });

  /**
   * The same filled string becomes the mail's SUBJECT and its opening, so a
   * line break in any field is a second header line. None of these fields is
   * constrained upstream: `BuyerDto.name` and `CreateEventDto.name` are
   * `@MaxLength(120)` with no charset rule, `CancelEventDto.reason` is
   * `@MaxLength(500)`.
   */
  describe('a value that would add a line of its own', () => {
    it.each(['first_name', 'event_name', 'reason', 'ticket_type'])(
      'flattens %s, whoever typed it',
      (field) => {
        const filled = fill(`Hi {{${field}}} — read on`, {
          [field]: 'Somchai\nSubject: Your Eventa account is locked',
        });
        expect(filled).not.toMatch(/[\r\n]/);
        expect(filled.split('\n')).toHaveLength(1);
      },
    );

    it('keeps the line breaks the TEMPLATE itself has', () => {
      // The rule is about substituted values, not the organizer's layout.
      expect(fill('Hi {{first_name}},\n\nWelcome.', fields)).toBe(
        'Hi Anong,\n\nWelcome.',
      );
    });
  });
});

describe('choosing which wording to send', () => {
  const wording = {
    subjectEn: 'English subject',
    bodyEn: 'English body',
    subjectTh: null,
    bodyTh: null,
  };

  it('uses the reader’s language when it has been written', () => {
    expect(pickWording(wording, 'en')).toEqual({
      subject: 'English subject',
      body: 'English body',
    });
  });

  it('falls back to Eventa’s copy for a language nobody wrote', () => {
    // NOT to the English an organizer wrote: a Thai reader getting English
    // because somebody edited one tab is a worse outcome than the built-in
    // Thai they would otherwise have had.
    expect(pickWording(wording, 'th')).toEqual({ subject: null, body: null });
  });

  it('falls back per FIELD, so half a row never sends a blank subject', () => {
    expect(pickWording({ ...wording, subjectEn: null }, 'en')).toEqual({
      subject: null,
      body: 'English body',
    });
  });
});
