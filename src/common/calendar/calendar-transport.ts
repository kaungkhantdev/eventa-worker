/**
 * The calendars this worker can sync meetings to (US-MTG-04/08) — the values of
 * `CALENDAR_PROVIDER`.
 *
 * Declared here rather than derived from `Env`: the env schema calls the
 * resolver below in one of its refinements, and a type read back off that
 * schema would make the schema's own inference circular.
 */
export const CALENDAR_TRANSPORTS = ['off', 'fake', 'google'] as const;

export type CalendarTransport = (typeof CALENDAR_TRANSPORTS)[number];

/** The variables the choice is made from — nothing else is read. */
export interface CalendarTransportEnv {
  CALENDAR_PROVIDER?: CalendarTransport;
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
}

/**
 * What an unset `CALENDAR_PROVIDER` means, decided in one place.
 *
 * 1. An explicit value wins.
 * 2. Otherwise Google, when BOTH halves of the OAuth client are set — a
 *    deployment that was given credentials meant to use them.
 * 3. Otherwise `off`: every meeting is marked "not connected", honestly.
 *
 * eventa-api resolves the same three variables by the same rule
 * (`resolveCalendarProvider`), and the two services MUST land on the same
 * answer. An api on `google` beside a worker on `off` would show a "connected"
 * header over cards that all say "not connected".
 *
 * A pure function so every branch is testable without an environment.
 */
export function resolveCalendarTransport(
  env: CalendarTransportEnv,
): CalendarTransport {
  if (env.CALENDAR_PROVIDER) return env.CALENDAR_PROVIDER;
  return env.GOOGLE_CALENDAR_CLIENT_ID && env.GOOGLE_CALENDAR_CLIENT_SECRET
    ? 'google'
    : 'off';
}
