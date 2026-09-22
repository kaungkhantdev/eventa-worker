import { resolveSmsTransport } from './sms-transport';

/**
 * What an UNSET `SMS_PROVIDER` means, which differs by environment on purpose.
 * There is no SMS account for this product yet, so production must be able to
 * boot with nothing configured — and must not pretend to have texted anybody
 * while it is.
 */
describe('resolveSmsTransport', () => {
  it('texts nothing, and claims nothing, when production has no provider', () => {
    // `log` here would write "sent" rows for texts that never left, which
    // US-MSG-06 forbids outright. Refusing to boot is not the alternative:
    // there is no account to configure yet.
    expect(
      resolveSmsTransport({ SMS_PROVIDER: undefined, NODE_ENV: 'production' }),
    ).toBe('off');
  });

  it('logs on a dev box, so the whole path is exercised without an account', () => {
    expect(
      resolveSmsTransport({ SMS_PROVIDER: undefined, NODE_ENV: 'development' }),
    ).toBe('log');
    expect(
      resolveSmsTransport({ SMS_PROVIDER: undefined, NODE_ENV: 'test' }),
    ).toBe('log');
  });

  it('takes an explicit choice over either default', () => {
    expect(
      resolveSmsTransport({ SMS_PROVIDER: 'off', NODE_ENV: 'development' }),
    ).toBe('off');
    expect(
      resolveSmsTransport({ SMS_PROVIDER: 'twilio', NODE_ENV: 'production' }),
    ).toBe('twilio');
    expect(resolveSmsTransport({ SMS_PROVIDER: 'log', NODE_ENV: 'test' })).toBe(
      'log',
    );
  });
});
