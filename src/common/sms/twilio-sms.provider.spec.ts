import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { TwilioSmsProvider, type FetchLike } from './twilio-sms.provider';

const SID = 'ACtest00000000000000000000000000';
const TOKEN = 'secret-token';
const FROM = 'Eventa';
const NUMBER = '+66812345678';
const BODY =
  'Eventa: you are registered for Bangkok Tech Week. Ref ORD-7K2M9QX4';

const config = {
  getOrThrow: (key: keyof Env) =>
    ({
      TWILIO_ACCOUNT_SID: SID,
      TWILIO_AUTH_TOKEN: TOKEN,
      TWILIO_FROM: FROM,
    })[key as string],
} as unknown as ConfigService<Env, true>;

const ok = (body: unknown = { sid: 'SM123' }, status = 201): Response =>
  ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

function provider(fetchImpl: FetchLike): TwilioSmsProvider {
  return new TwilioSmsProvider(config, fetchImpl);
}

describe('TwilioSmsProvider', () => {
  let fetchImpl: jest.MockedFunction<FetchLike>;

  beforeEach(() => {
    fetchImpl = jest.fn().mockResolvedValue(ok());
  });

  afterEach(() => jest.restoreAllMocks());

  it('is enabled — a configured account is one that can text', () => {
    expect(provider(fetchImpl).enabled).toBe(true);
  });

  describe('the request it makes', () => {
    it('posts the message to this account’s Messages resource', async () => {
      await provider(fetchImpl).send({ to: NUMBER, text: BODY });

      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(
        `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
      );
      expect(init?.method).toBe('POST');
    });

    it('authenticates with the account sid and token', async () => {
      await provider(fetchImpl).send({ to: NUMBER, text: BODY });

      const headers = fetchImpl.mock.calls[0][1]?.headers;
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
      );
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('sends To, From and Body as a form', async () => {
      await provider(fetchImpl).send({ to: NUMBER, text: BODY });

      const form = new URLSearchParams(
        String(fetchImpl.mock.calls[0][1]?.body),
      );
      expect(form.get('To')).toBe(NUMBER);
      expect(form.get('From')).toBe(FROM);
      expect(form.get('Body')).toBe(BODY);
    });

    it('gives up rather than holding a consumer open forever', async () => {
      await provider(fetchImpl).send({ to: NUMBER, text: BODY });
      expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('a message Twilio accepted', () => {
    it('resolves, and logs the provider’s id — not the number or the text', async () => {
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);

      await expect(
        provider(fetchImpl).send({ to: NUMBER, text: BODY }),
      ).resolves.toBeUndefined();

      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain('SM123');
      expect(logged).not.toContain('812345678');
      expect(logged).not.toContain('ORD-7K2M9QX4');
    });
  });

  describe('a message Twilio refused', () => {
    const refused = (status: number, code = 21211) =>
      provider(
        jest.fn().mockResolvedValue(
          ok(
            {
              code,
              status,
              // Twilio quotes the number back at us. This must not travel.
              message: `The 'To' number ${NUMBER} is not a valid phone number.`,
            },
            status,
          ),
        ) as jest.MockedFunction<FetchLike>,
      ).send({ to: NUMBER, text: BODY });

    it('does not retry a permanent rejection', async () => {
      // A number Twilio will never accept is not worth four more attempts.
      await expect(refused(400)).rejects.toMatchObject({ retryable: false });
    });

    it('retries a provider outage or a rate limit', async () => {
      await expect(refused(503)).rejects.toMatchObject({ retryable: true });
      await expect(refused(429)).rejects.toMatchObject({ retryable: true });
    });

    it('says what happened without repeating the number or the text', async () => {
      // The consumer logs the error and the recorder writes its message into
      // the delivery log — so anything in here is published twice over.
      await expect(refused(400)).rejects.toThrow(/HTTP 400.*21211/);
      await expect(refused(400)).rejects.not.toThrow(/812345678/);
      await expect(refused(400)).rejects.not.toThrow(/ORD-7K2M9QX4/);
    });

    it('carries neither `code` nor `responseCode`', async () => {
      // `failure.ts` reads both with SMTP and Postgres meanings, where 5xx is
      // PERMANENT — the opposite of HTTP. A Twilio code landing in either
      // would invert the retry decision this class just made.
      const thrown = await refused(503).catch((err: unknown) => err);
      expect('code' in (thrown as object)).toBe(false);
      expect('responseCode' in (thrown as object)).toBe(false);
    });
  });

  describe('a request that never got an answer', () => {
    it('retries a refused connection', async () => {
      const dead = jest
        .fn()
        .mockRejectedValue(
          new Error('fetch failed'),
        ) as jest.MockedFunction<FetchLike>;

      await expect(
        provider(dead).send({ to: NUMBER, text: BODY }),
      ).rejects.toMatchObject({ retryable: true });
    });

    it('retries a timeout', async () => {
      const slow = jest.fn().mockRejectedValue(
        Object.assign(new Error('The operation was aborted'), {
          name: 'TimeoutError',
        }),
      ) as jest.MockedFunction<FetchLike>;

      await expect(
        provider(slow).send({ to: NUMBER, text: BODY }),
      ).rejects.toMatchObject({ retryable: true });
    });
  });
});
