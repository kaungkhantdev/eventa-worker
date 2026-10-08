import { Logger } from '@nestjs/common';
import { LogSmsProvider } from './log-sms.provider';
import { OffSmsProvider } from './off-sms.provider';
import type { SmsProvider } from './sms.provider';

const NUMBER = '+66812345678';
const BODY =
  'Eventa: you are registered for Bangkok Tech Week. Ref ORD-7K2M9QX4';

/** Everything any logger method was handed, flattened to one searchable string. */
function everythingLogged(spies: jest.SpyInstance[]): string {
  return spies.map((spy) => JSON.stringify(spy.mock.calls)).join(' ');
}

describe('LogSmsProvider (dev)', () => {
  let spies: jest.SpyInstance[];

  beforeEach(() => {
    spies = (['log', 'debug', 'warn', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('is enabled, so a dev box exercises the whole path', async () => {
    await expect(
      new LogSmsProvider().send({ to: NUMBER, text: BODY }),
    ).resolves.toBeUndefined();
    expect(new LogSmsProvider().enabled).toBe(true);
  });

  it('never logs the number or the body — not even at debug', async () => {
    // A phone number is PII and a confirmation text carries a booking
    // reference and a ticket link. LOG_LEVEL is `debug` in the shipped .env,
    // so "only at debug" is not a hiding place.
    await new LogSmsProvider().send({ to: NUMBER, text: BODY });

    const logged = everythingLogged(spies);
    expect(logged).not.toContain('812345678');
    expect(logged).not.toContain('ORD-7K2M9QX4');
    expect(logged).not.toContain('Bangkok Tech Week');
  });

  it('says enough to tell a dev something went out', async () => {
    await new LogSmsProvider().send({ to: NUMBER, text: BODY });
    expect(everythingLogged(spies)).toContain(String(BODY.length));
  });
});

describe('OffSmsProvider', () => {
  it('is not enabled, so handlers skip the work entirely', () => {
    expect(new OffSmsProvider().enabled).toBe(false);
  });

  it('accepts a send without sending or recording anything', async () => {
    // Reached only if a caller ignores `enabled`. Resolving keeps that a
    // no-op rather than a dead-lettered registration.
    const spies = (['log', 'debug', 'warn'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    // Exercised through the PORT, which is how a handler reaches it — the
    // class itself ignores the message and declares no parameter for it.
    const off: SmsProvider = new OffSmsProvider();
    await expect(off.send({ to: NUMBER, text: BODY })).resolves.toBeUndefined();
    expect(everythingLogged(spies)).not.toContain('812345678');
    jest.restoreAllMocks();
  });
});
