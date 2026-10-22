import { isRetryable } from '../../rabbitmq/failure';
import {
  CALENDAR_EXPIRED_SENTENCE,
  CALENDAR_UNAVAILABLE_SENTENCE,
  CalendarSyncError,
  googleEventIdOf,
} from './calendar.provider';

describe('CalendarSyncError', () => {
  /**
   * `failure.ts` believes a boolean `retryable` before anything else, so the
   * verdict must be an own FIELD on the error — not a getter on the prototype
   * that a spread or a serializer would lose.
   */
  it('carries its verdict as an own field the consumer reads', () => {
    const err = new CalendarSyncError('unavailable', 503);
    expect(Object.prototype.hasOwnProperty.call(err, 'retryable')).toBe(true);
  });

  it('retries an outage', () => {
    const err = new CalendarSyncError('unavailable', 503);
    expect(err.retryable).toBe(true);
    expect(isRetryable(err)).toBe(true);
    expect(err.message).toBe('Google Calendar is unavailable right now.');
    expect(err.message).toBe(CALENDAR_UNAVAILABLE_SENTENCE);
  });

  it('does not retry a refusal, and names only its HTTP status', () => {
    const err = new CalendarSyncError('rejected', 400);
    expect(err.retryable).toBe(false);
    expect(isRetryable(err)).toBe(false);
    expect(err.message).toBe('Google Calendar refused the request (HTTP 400).');
  });

  it('does not retry a revoked connection — only a reconnect fixes it', () => {
    const err = new CalendarSyncError('auth_revoked', 400);
    expect(err.retryable).toBe(false);
    expect(isRetryable(err)).toBe(false);
    expect(err.message).toBe('The Google Calendar connection has expired.');
    expect(err.message).toBe(CALENDAR_EXPIRED_SENTENCE);
  });

  it('keeps the failure kind and status for the caller to branch on', () => {
    const err = new CalendarSyncError('rejected', 404);
    expect(err.failure).toBe('rejected');
    expect(err.status).toBe(404);
    expect(err.name).toBe('CalendarSyncError');
  });

  it('still says something fixed when a refusal had no status', () => {
    expect(new CalendarSyncError('rejected', null).message).toBe(
      'Google Calendar refused the request.',
    );
  });
});

describe('googleEventIdOf', () => {
  const meetingId = '3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b';

  it('is the meeting id without its hyphens', () => {
    expect(googleEventIdOf(meetingId)).toBe('3f2b8c1e9a4d4e6f8b7a0c1d2e3f4a5b');
  });

  it('is a valid Google event id: 5–1024 characters of base32hex', () => {
    // Google accepts lowercase a–v and digits; hex is a subset.
    expect(googleEventIdOf(meetingId)).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it('is deterministic, so a retry or a racing cancel names the same event', () => {
    expect(googleEventIdOf(meetingId)).toBe(googleEventIdOf(meetingId));
  });
});
