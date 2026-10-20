import type { ConfigService } from '@nestjs/config';
import {
  DEV_SECRET_ENCRYPTION_KEY,
  type Env,
} from '../../config/env.validation';
import { SecretCipher } from './secret-cipher';

const configWith = (key: string) =>
  ({
    getOrThrow: (name: keyof Env) =>
      name === 'SECRET_ENCRYPTION_KEY' ? key : undefined,
  }) as unknown as ConfigService<Env, true>;

/**
 * Produced OUTSIDE this service, by eventa-api's layout — `iv(12) | tag(16) |
 * ciphertext`, AES-256-GCM — under the published dev key. If this stops
 * decrypting, the worker can no longer read a refresh token the api stored,
 * and every meeting sync ends "could not be read".
 */
const API_FIXTURE = Buffer.from(
  'a1b2c3d4e5f60718293a4b5c35ae8489b2cb4150a489c7f6a980b456fa27867b4927fea043d850ebb303025cdbe90b9275bc3d4bf541ed',
  'hex',
);
const API_FIXTURE_PLAINTEXT = '1//0e-fixture-refresh-token';

describe('SecretCipher (worker copy of eventa-api’s)', () => {
  const cipher = new SecretCipher(configWith(DEV_SECRET_ENCRYPTION_KEY));

  it('decrypts what eventa-api encrypted under the same key', () => {
    expect(cipher.decrypt(API_FIXTURE)).toBe(API_FIXTURE_PLAINTEXT);
  });

  it('round-trips its own output, in the same layout', () => {
    const sealed = cipher.encrypt('fake-refresh-abc');

    // iv(12) + tag(16) + one byte of ciphertext per byte of plaintext.
    expect(sealed.length).toBe(12 + 16 + 'fake-refresh-abc'.length);
    expect(cipher.decrypt(sealed)).toBe('fake-refresh-abc');
  });

  it('never stores the plaintext in the clear', () => {
    const sealed = cipher.encrypt('fake-refresh-abc');
    expect(sealed.toString('latin1')).not.toContain('fake-refresh');
  });

  it('uses a fresh iv each time, so equal secrets do not look equal', () => {
    expect(cipher.encrypt('same').equals(cipher.encrypt('same'))).toBe(false);
  });

  it('refuses a payload that was tampered with', () => {
    const tampered = Buffer.from(API_FIXTURE);
    tampered[tampered.length - 1] ^= 0x01;

    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('refuses a payload sealed under another key', () => {
    // The symptom of a worker whose SECRET_ENCRYPTION_KEY is not the api's.
    const other = new SecretCipher(
      configWith(Buffer.alloc(32, 9).toString('base64')),
    );
    expect(() => other.decrypt(API_FIXTURE)).toThrow();
  });
});
