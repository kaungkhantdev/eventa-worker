import { resolveCalendarTransport } from './calendar-transport';

/**
 * What an unset `CALENDAR_PROVIDER` means (US-MTG-04/08). eventa-api resolves
 * the same three variables by the same rule, and the two must agree: an api on
 * `google` beside a worker on `off` would show "connected" over every card
 * saying "not connected".
 */
describe('resolveCalendarTransport', () => {
  const client = {
    GOOGLE_CALENDAR_CLIENT_ID: 'client-id',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'client-secret',
  };

  it('takes an explicit choice over anything it could derive', () => {
    expect(
      resolveCalendarTransport({ CALENDAR_PROVIDER: 'off', ...client }),
    ).toBe('off');
    expect(
      resolveCalendarTransport({ CALENDAR_PROVIDER: 'fake', ...client }),
    ).toBe('fake');
    expect(
      resolveCalendarTransport({ CALENDAR_PROVIDER: 'google', ...client }),
    ).toBe('google');
  });

  it('uses Google when both halves of the OAuth client are set', () => {
    expect(
      resolveCalendarTransport({ CALENDAR_PROVIDER: undefined, ...client }),
    ).toBe('google');
  });

  it('is off when either half is missing', () => {
    expect(
      resolveCalendarTransport({
        CALENDAR_PROVIDER: undefined,
        GOOGLE_CALENDAR_CLIENT_ID: 'client-id',
        GOOGLE_CALENDAR_CLIENT_SECRET: undefined,
      }),
    ).toBe('off');
    expect(
      resolveCalendarTransport({
        CALENDAR_PROVIDER: undefined,
        GOOGLE_CALENDAR_CLIENT_ID: undefined,
        GOOGLE_CALENDAR_CLIENT_SECRET: 'client-secret',
      }),
    ).toBe('off');
  });

  it('is off when nothing at all is configured', () => {
    expect(
      resolveCalendarTransport({
        CALENDAR_PROVIDER: undefined,
        GOOGLE_CALENDAR_CLIENT_ID: undefined,
        GOOGLE_CALENDAR_CLIENT_SECRET: undefined,
      }),
    ).toBe('off');
  });
});
