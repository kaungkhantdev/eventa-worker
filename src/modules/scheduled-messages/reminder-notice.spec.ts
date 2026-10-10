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

/**
 * A buyer's own name with a line break in it. eventa-api's `BuyerDto.name` is
 * `@IsString() @IsNotEmpty() @MaxLength(120)` — no charset rule and no newline
 * rule — so this is a name the API accepts and the bus delivers.
 *
 * Built rather than written as an escape so the assertion below cannot pass by
 * the source having been normalised.
 */
const LINE_BREAK = String.fromCodePoint(0x0a);
const NAME_THAT_ADDS_A_LINE =
  'Somchai' + LINE_BREAK + 'Subject: Your Eventa account is locked';

describe('free text that would add a line of its own', () => {
  it('adds no line to the body', () => {
    const benign = reminderBody({
      ...base,
      locale: 'en',
      attendeeName: 'Somchai',
    }).split(LINE_BREAK).length;
    const hostile = reminderBody({
      ...base,
      locale: 'en',
      attendeeName: NAME_THAT_ADDS_A_LINE,
    }).split(LINE_BREAK).length;
    expect(hostile).toBe(benign);
  });

  it('never breaks the subject, where a second line is a header', () => {
    expect(
      reminderSubject({
        ...base,
        locale: 'en',
        subject: NAME_THAT_ADDS_A_LINE,
      }),
    ).not.toContain(LINE_BREAK);
  });
});

/**
 * The fields beside the name.
 *
 * The shared "adds no line to the body" test varies only `attendeeName`, so it
 * passed while two other borrowed values still added one: measured, a newline
 * in `eventName` or in `where` took this body from 9 lines to 10, putting an
 * attacker-chosen line into a message the attendee reads as Eventa's.
 *
 * Both are the ORGANIZER's text and the reader is an attendee, so this is a
 * boundary between two principals, not a value the reader owns. `opening` is
 * deliberately not flattened: it is the organizer's own message and is meant
 * to be several lines.
 */
describe('a borrowed value that is not the name', () => {
  const LF = String.fromCodePoint(0x0a);
  const clean = () => reminderBody({ ...base, locale: 'en' }).split(LF).length;

  it('keeps the event name on its own line', () => {
    const body = reminderBody({
      ...base,
      locale: 'en',
      eventName: 'Summit' + LF + 'Eventa Security: https://evil.test',
    });

    expect(body.split(LF)).toHaveLength(clean());
    expect(body).not.toMatch(/^Eventa Security/m);
  });

  it('keeps the place on its own line', () => {
    const body = reminderBody({
      ...base,
      locale: 'en',
      where: 'QSNCC' + LF + 'Eventa Security: https://evil.test',
    });

    expect(body.split(LF)).toHaveLength(clean());
  });

  /** The organizer's own message is theirs to lay out, and stays multi-line. */
  it('leaves the organizer’s own opening its own lines', () => {
    const body = reminderBody({
      ...base,
      locale: 'en',
      opening: 'Dear guest,' + LF + '' + LF + 'We look forward to it.',
    });

    expect(body.split(LF).length).toBeGreaterThan(clean() - 1);
    expect(body).toContain('We look forward to it.');
  });
});
