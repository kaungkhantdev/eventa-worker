import type { Locale } from '../../db/schema/events';
import { formatWhen } from '../registration/confirmation-email';

/**
 * Where and when a session sits — the four fields US-PROG-03 treats as a
 * MATERIAL change, and the only ones eventa-api emits a notice for. A retitled
 * or re-described session is the same session at the same time in the same
 * room, and a REMOVED one notifies nobody at all (US-PROG-04) — so "changed"
 * here never means cancelled.
 */
export interface SessionSitting {
  /** The event day NUMBER, 1-based. Not a date — see {@link whenText}. */
  day: number;
  startTime: string;
  endTime: string | null;
  room: string | null;
}

/** What day 1 of the event is: the start instant, and the clock it runs on. */
export interface EventClock {
  startAt: Date;
  timezone: string;
}

/** `9:05` or `09:05:00` — the hour may arrive unpadded, the seconds absent. */
const HOUR_MINUTE_SECOND = /^\d{1,2}:\d{2}(:\d{2})?$/;

/** `2026-10-12`. */
const DATE_KEY_LENGTH = 10;
const HOUR_MINUTE_LENGTH = 5;

export function whenMoved(
  before: SessionSitting,
  after: SessionSitting,
): boolean {
  return (
    before.day !== after.day ||
    before.startTime !== after.startTime ||
    before.endTime !== after.endTime
  );
}

export function whereMoved(
  before: SessionSitting,
  after: SessionSitting,
): boolean {
  return before.room !== after.room;
}

/** Whether there is anything to tell anybody about at all. */
export function sittingMoved(
  before: SessionSitting,
  after: SessionSitting,
): boolean {
  return whenMoved(before, after) || whereMoved(before, after);
}

/**
 * When a session sits, as the reader of the notice sees it — e.g.
 * `Monday, 12 October 2026 at 14:00–15:00`.
 *
 * Two things here are easy to get wrong, and both would reach an attendee.
 *
 * **The day is an INDEX, not a date.** eventa-api schedules sessions against a
 * 1-based day number and says nothing about what those days are called, so the
 * date is counted from the event's own start — and counted on the EVENT's
 * calendar, because an event starting 17:30 UTC has already begun tomorrow in
 * Bangkok and a UTC count would date every day of it one day early. (eventa-web
 * counts the same strip the same way, in `agendaDaysOf`.)
 *
 * **The times are NOT instants.** `start_time`/`end_time` are Postgres `time`
 * columns: a naive wall clock on that calendar. Everything else here is UTC on
 * the wire, so the instinct is to convert — which would move a 14:00 session to
 * 21:00. Instead the day and the wall clock are composed into the instant whose
 * UTC rendering is that wall clock, and formatted pinned to UTC, which prints
 * back exactly what the organizer typed.
 */
export function whenText(
  sitting: SessionSitting,
  clock: EventClock,
  locale: Locale,
): string {
  const start = formatWhen(
    instantOf(dayOfEvent(clock, sitting.day), sitting.startTime),
    UTC,
    locale,
  );
  return sitting.endTime
    ? `${start}${EN_DASH}${hourMinute(sitting.endTime)}`
    : start;
}

/**
 * Rendering timezone, not the event's: the wall clock is already the event's
 * local time, so pinning the formatter to UTC passes it through unshifted.
 */
const UTC = 'UTC';
/** An en dash between the two times, as a range takes rather than a hyphen. */
const EN_DASH = '–';

/** `2026-10-12` for day 1, the next calendar day for day 2, and so on. */
function dayOfEvent(clock: EventClock, day: number): string {
  const [year, month, dayOfMonth] = firstDayKey(clock).split('-').map(Number);
  // Three plain numbers: the timezone is spent, and nothing is left to shift.
  const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
  date.setUTCDate(date.getUTCDate() + day - 1);
  return date.toISOString().slice(0, DATE_KEY_LENGTH);
}

/** The event's first calendar day where the event happens, as `YYYY-MM-DD`. */
function firstDayKey(clock: EventClock): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: clock.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(clock.startAt);
}

/** The instant whose UTC rendering IS this wall clock on this day. */
function instantOf(dayKey: string, time: string): Date {
  return new Date(`${dayKey}T${isoTime(time)}Z`);
}

function isoTime(time: string): string {
  if (!HOUR_MINUTE_SECOND.test(time)) throw new MalformedSessionTimeError(time);
  const [hours, minutes, seconds = '00'] = time.split(':');
  return `${hours.padStart(2, '0')}:${minutes}:${seconds}`;
}

function hourMinute(time: string): string {
  return isoTime(time).slice(0, HOUR_MINUTE_LENGTH);
}

/**
 * A time this notice cannot render. Thrown rather than rendered: a message
 * parked in the dead-letter queue is one a person will come and look at, and
 * `Invalid Date` in an attendee's inbox is one nobody ever sees.
 */
export class MalformedSessionTimeError extends Error {
  /**
   * Read by `isRetryable`: poison, not transient. The same payload would fail
   * identically four more times, and the ladder would only postpone the moment
   * a person comes and looks at it.
   */
  readonly retryable = false;

  constructor(time: string) {
    super(`Session time "${time}" is not HH:MM or HH:MM:SS`);
    this.name = 'MalformedSessionTimeError';
  }
}
