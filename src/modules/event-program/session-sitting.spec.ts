import { isRetryable } from '../../rabbitmq/failure';
import {
  MalformedSessionTimeError,
  sittingMoved,
  whenMoved,
  whenText,
  whereMoved,
  type EventClock,
  type SessionSitting,
} from './session-sitting';

/** Day 1 is 12 October 2026 in Bangkok; 10:30 UTC is 17:30 there. */
const clock: EventClock = {
  startAt: new Date('2026-10-12T03:00:00.000Z'),
  timezone: 'Asia/Bangkok',
};

const sitting: SessionSitting = {
  day: 1,
  startTime: '14:00:00',
  endTime: '15:00:00',
  room: 'Hall A',
};

describe('what counts as a session moving', () => {
  it('is not moved when the sitting is identical', () => {
    // A redelivery, or a DLQ replay, carries the same payload twice. "This
    // session changed" with nothing to show for it is worse than silence.
    expect(sittingMoved(sitting, { ...sitting })).toBe(false);
  });

  it.each([
    ['a new day', { day: 2 }],
    ['a new start time', { startTime: '09:00:00' }],
    ['a new end time', { endTime: '16:30:00' }],
  ])('counts %s as a change of when', (_label, change) => {
    const after = { ...sitting, ...change };
    expect(whenMoved(sitting, after)).toBe(true);
    expect(whereMoved(sitting, after)).toBe(false);
    expect(sittingMoved(sitting, after)).toBe(true);
  });

  it('counts a new room as a change of where, not of when', () => {
    const after = { ...sitting, room: 'Hall B' };
    expect(whereMoved(sitting, after)).toBe(true);
    expect(whenMoved(sitting, after)).toBe(false);
  });

  it('counts a room being set or cleared as a change of where', () => {
    expect(whereMoved({ ...sitting, room: null }, sitting)).toBe(true);
    expect(whereMoved(sitting, { ...sitting, room: null })).toBe(true);
  });
});

describe('whenText', () => {
  it('renders the wall clock as it stands, never shifted into UTC', () => {
    // `start_time` is a Postgres `time`: a naive wall clock on the event's own
    // calendar, NOT an instant. Treating it as UTC and converting would move a
    // 14:00 session to 21:00 in Bangkok.
    expect(whenText(sitting, clock, 'en')).toBe(
      'Monday, 12 October 2026 at 14:00–15:00',
    );
  });

  it('counts the day index from the event start on the event’s own calendar', () => {
    // Day 2 is the next calendar day, not startAt + 24h.
    expect(whenText({ ...sitting, day: 2 }, clock, 'en')).toBe(
      'Tuesday, 13 October 2026 at 14:00–15:00',
    );
  });

  it('counts that first day in the event’s timezone, not in UTC', () => {
    // 17:30 UTC is already the 13th in Bangkok. Counting in UTC would label
    // every day of this event one day early.
    const evening: EventClock = {
      startAt: new Date('2026-10-12T17:30:00.000Z'),
      timezone: 'Asia/Bangkok',
    };
    expect(whenText(sitting, evening, 'en')).toBe(
      'Tuesday, 13 October 2026 at 14:00–15:00',
    );
  });

  it('omits the dash when the session has no end time', () => {
    expect(whenText({ ...sitting, endTime: null }, clock, 'en')).toBe(
      'Monday, 12 October 2026 at 14:00',
    );
  });

  it('reads the date and time in Thai for a Thai reader', () => {
    expect(whenText(sitting, clock, 'th')).toBe(
      'วันจันทร์ที่ 12 ตุลาคม พ.ศ. 2569 เวลา 14:00–15:00',
    );
  });

  it('tolerates a time with no seconds', () => {
    // The API sends `HH:MM:SS` today. A shorter form must still render rather
    // than reach an attendee as "Invalid Date".
    expect(
      whenText({ ...sitting, startTime: '9:05', endTime: null }, clock, 'en'),
    ).toBe('Monday, 12 October 2026 at 09:05');
  });
});

describe('a time that cannot be rendered', () => {
  const nonsense = { ...sitting, startTime: 'lunchtime' };

  it('is refused rather than sent as “Invalid Date”', () => {
    expect(() => whenText(nonsense, clock, 'en')).toThrow(
      MalformedSessionTimeError,
    );
  });

  it('parks straight away instead of climbing the retry ladder', () => {
    // Poison: the same payload fails identically every time, and four delayed
    // attempts only postpone the moment a person looks at it.
    expect(isRetryable(new MalformedSessionTimeError('lunchtime'))).toBe(false);
  });
});
