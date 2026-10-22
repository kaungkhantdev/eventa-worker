import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import {
  type CalendarTransport,
  resolveCalendarTransport,
} from './calendar-transport';
import { CalendarProvider } from './calendar.provider';
import { FakeCalendarProvider } from './fake-calendar.provider';
import { GoogleCalendarProvider } from './google-calendar.provider';
import { OffCalendarProvider } from './off-calendar.provider';

/** Builds one calendar from config. Anything satisfying the port qualifies. */
type TransportFactory = (config: ConfigService<Env, true>) => CalendarProvider;

/**
 * The calendars, keyed by the resolved provider name — a lookup table rather
 * than a branch, as `SmsModule` and `EmailModule` have. The `Record` is keyed
 * by the name's own type, so a new `CALENDAR_PROVIDER` value with no calendar
 * behind it does not compile.
 */
const TRANSPORTS: Record<CalendarTransport, TransportFactory> = {
  off: () => new OffCalendarProvider(),
  fake: () => new FakeCalendarProvider(),
  google: (config) => new GoogleCalendarProvider(config),
};

/**
 * The CalendarProvider for this process, named once in the log.
 *
 * The line is how an operator spots the one misconfiguration nothing else
 * reports: eventa-api resolving `google` while this worker resolves `off`, so
 * the Meetings header says "connected" over cards that all say "not connected".
 * It names the provider and nothing else — never a client id or secret.
 */
export function provideCalendar(
  config: ConfigService<Env, true>,
): CalendarProvider {
  const name = resolveCalendarTransport({
    CALENDAR_PROVIDER: config.get('CALENDAR_PROVIDER', { infer: true }),
    GOOGLE_CALENDAR_CLIENT_ID: config.get('GOOGLE_CALENDAR_CLIENT_ID', {
      infer: true,
    }),
    GOOGLE_CALENDAR_CLIENT_SECRET: config.get('GOOGLE_CALENDAR_CLIENT_SECRET', {
      infer: true,
    }),
  });
  new Logger(CalendarModule.name).log(`Calendar provider: ${name}`);
  return TRANSPORTS[name](config);
}

/**
 * Provides the CalendarProvider port app-wide (US-MTG-04..08): Google, the dev
 * fake, or `off`, resolved by the same rule eventa-api uses.
 *
 * Global, like SmsModule, so the meetings module injects the port without
 * importing this. Nothing is wrapped around it: a calendar sync's outcome is
 * recorded on the meeting row itself (`meetings.sync_status`), not in the
 * message delivery log.
 *
 * NOTHING HAS BEEN SYNCED TO A REAL GOOGLE ACCOUNT. The Google adapter is
 * proven against a stubbed fetch only.
 */
@Global()
@Module({
  providers: [
    {
      provide: CalendarProvider,
      useFactory: provideCalendar,
      inject: [ConfigService],
    },
  ],
  exports: [CalendarProvider],
})
export class CalendarModule {}
