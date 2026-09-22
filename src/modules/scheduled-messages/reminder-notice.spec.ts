import {
  myEventsUrlFor,
  reminderBody,
  reminderSubject,
} from './reminder-notice';

const base = {
  attendeeName: 'Anan',
  eventName: 'Bangkok Summit 2026',
  // 09:00 Bangkok on 1 Sept 2026.
  startAt: new Date('2026-09-01T02:00:00Z'),
  timezone: 'Asia/Bangkok',
  where: 'QSNCC, Bangkok',
  myEventsUrl: 'https://web.test/portal/my-events',
};

describe('the event reminder (US-MSG-01)', () => {
  it('says when and where, in the event’s own timezone', () => {
    // Bangkok wall clock, not the server's: a reminder saying 02:00 for a
    // 09:00 start is worse than none.
    const body = reminderBody({ ...base, locale: 'en' });
    expect(body).toContain('9:00');
    expect(body).toContain('QSNCC, Bangkok');
    expect(body).toContain('https://web.test/portal/my-events');
  });

  it('writes Thai for a Thai reader, date included', () => {
    const body = reminderBody({ ...base, locale: 'th' });
    expect(body).toContain('สวัสดีคุณ Anan');
    // th-TH renders the Buddhist era — what a Thai reader expects.
    expect(body).toMatch(/2569/);
    expect(reminderSubject({ ...base, locale: 'th' })).toContain('พรุ่งนี้');
  });

  it('leaves the place out when there is none, rather than printing a blank', () => {
    const body = reminderBody({ ...base, where: null, locale: 'en' });
    expect(body).not.toMatch(/Where:\s*$/m);
  });

  it('keeps the when, the where and the ticket link whatever the organizer wrote', () => {
    // The time, the place and the way to the QR code are why the message
    // exists. An organizer rewriting the greeting must not remove them.
    const body = reminderBody({
      ...base,
      locale: 'en',
      opening: 'See you soon!',
    });
    expect(body).toContain('See you soon!');
    expect(body).toContain('QSNCC, Bangkok');
    expect(body).toContain(base.myEventsUrl);
  });
});

describe('the ticket link', () => {
  it('is absolute, and does not double a trailing slash', () => {
    expect(myEventsUrlFor('https://web.test/')).toBe(
      'https://web.test/portal/my-events',
    );
  });
});
