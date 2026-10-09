import {
  sessionChangeBody,
  sessionChangeSubject,
  type SessionChangeNotice,
} from './session-change-notice';

const moved: SessionChangeNotice = {
  locale: 'en',
  attendeeName: 'Somchai',
  eventName: 'Bangkok Summit 2026',
  sessionTitle: 'Opening Keynote',
  when: {
    before: 'Monday, 12 October 2026 at 14:00–15:00',
    after: 'Tuesday, 13 October 2026 at 09:00–10:00',
  },
  room: { before: 'Hall A', after: 'Hall B' },
};

describe('sessionChangeSubject', () => {
  it('names the session, so the inbox already says which one', () => {
    expect(sessionChangeSubject(moved)).toBe('Session moved: Opening Keynote');
  });

  it('is in Thai for a Thai reader', () => {
    expect(sessionChangeSubject({ ...moved, locale: 'th' })).toContain(
      'Opening Keynote',
    );
    expect(sessionChangeSubject({ ...moved, locale: 'th' })).toMatch(/[ก-๙]/);
  });
});

describe('sessionChangeBody', () => {
  it('says what moved, from what to what', () => {
    const body = sessionChangeBody(moved);
    expect(body).toContain('Session: Opening Keynote');
    expect(body).toContain(
      'When: Monday, 12 October 2026 at 14:00–15:00 → Tuesday, 13 October 2026 at 09:00–10:00',
    );
    expect(body).toContain('Where: Hall A → Hall B');
  });

  it('greets the reader and names the event', () => {
    const body = sessionChangeBody(moved);
    expect(body).toContain('Hi Somchai,');
    expect(body).toContain('Bangkok Summit 2026');
  });

  it('reassures the reader their ticket still works', () => {
    // The event still happens: the whole reason this is a courtesy rather than
    // a cancellation. Without the line a rescheduled session reads like one.
    expect(sessionChangeBody(moved)).toMatch(/ticket/i);
  });

  it('leaves out the room line when only the time moved', () => {
    const body = sessionChangeBody({ ...moved, room: null });
    expect(body).toContain('When:');
    expect(body).not.toContain('Where:');
  });

  it('leaves out the when line when only the room moved', () => {
    const body = sessionChangeBody({ ...moved, when: null });
    expect(body).toContain('Where:');
    expect(body).not.toContain('When:');
  });

  it('never prints an empty value for a room nobody has announced', () => {
    // US-MSG-01: a message is never sent with a personalization field left
    // unfilled. "Where:  → Hall B" is exactly that.
    const body = sessionChangeBody({
      ...moved,
      room: { before: null, after: 'Hall B' },
    });
    expect(body).toContain('Where: Not announced yet → Hall B');
  });

  it('writes the whole notice in Thai for a Thai reader', () => {
    const body = sessionChangeBody({
      ...moved,
      locale: 'th',
      room: { before: null, after: 'Hall B' },
    });
    expect(body).toContain('สวัสดีคุณ Somchai');
    expect(body).toContain('Opening Keynote');
    expect(body).toContain('Hall B');
    // No English label survives into a Thai notice.
    expect(body).not.toMatch(/When:|Where:|Session:|Not announced/);
  });
});
