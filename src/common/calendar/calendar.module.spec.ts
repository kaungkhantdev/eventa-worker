import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { provideCalendar } from './calendar.module';
import { FakeCalendarProvider } from './fake-calendar.provider';
import { GoogleCalendarProvider } from './google-calendar.provider';
import { OffCalendarProvider } from './off-calendar.provider';

const configOf = (env: Partial<Env>) =>
  ({
    get: (key: keyof Env) => env[key],
    getOrThrow: (key: keyof Env) => {
      const value = env[key];
      if (value === undefined) throw new Error(`${key} missing`);
      return value;
    },
  }) as unknown as ConfigService<Env, true>;

const client = {
  GOOGLE_CALENDAR_CLIENT_ID: 'client-id',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'client-secret',
};

/** The CalendarProvider port is bound once, from config (US-MTG-04/08). */
describe('provideCalendar', () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('binds nothing that calls out when no calendar is configured', () => {
    const provider = provideCalendar(configOf({}));
    expect(provider).toBeInstanceOf(OffCalendarProvider);
    expect(provider.enabled).toBe(false);
  });

  it('binds the fake when asked for it', () => {
    expect(
      provideCalendar(configOf({ CALENDAR_PROVIDER: 'fake' })),
    ).toBeInstanceOf(FakeCalendarProvider);
  });

  it('binds Google when asked, or when both client halves are set', () => {
    expect(
      provideCalendar(configOf({ CALENDAR_PROVIDER: 'google', ...client })),
    ).toBeInstanceOf(GoogleCalendarProvider);
    expect(provideCalendar(configOf(client))).toBeInstanceOf(
      GoogleCalendarProvider,
    );
  });

  it('says which provider it bound, once, and nothing secret', () => {
    provideCalendar(configOf({ CALENDAR_PROVIDER: 'google', ...client }));

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Calendar provider: google');
    expect(JSON.stringify(log.mock.calls)).not.toContain('client-secret');
  });

  it('names off as off, so a mismatch with eventa-api is visible at boot', () => {
    provideCalendar(configOf({}));
    expect(log).toHaveBeenCalledWith('Calendar provider: off');
  });
});

describe('OffCalendarProvider', () => {
  const off = new OffCalendarProvider();

  it('is not enabled, so the sync records "not connected" without calling it', () => {
    expect(off.enabled).toBe(false);
  });

  it('refuses every call made anyway', async () => {
    await expect(off.accessToken()).rejects.toThrow(/not configured/);
    await expect(off.upsertEvent()).rejects.toThrow(/not configured/);
    await expect(off.cancelEvent()).rejects.toThrow(/not configured/);
  });
});
