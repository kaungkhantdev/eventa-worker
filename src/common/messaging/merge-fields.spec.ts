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
