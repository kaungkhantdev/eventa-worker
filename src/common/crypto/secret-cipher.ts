import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.validation';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;

/**
 * A BYTE-COMPATIBLE COPY of eventa-api's `src/common/crypto/secret-cipher.ts`:
 * AES-256-GCM, stored as `iv(12) | authTag(16) | ciphertext`.
 *
 * It exists for one secret today — the workspace's Google Calendar refresh
 * token (US-MTG-08), which eventa-api encrypts when an Admin connects and this
 * service must read back to sync a meeting. There is no shared package between
 * the two services, so the layout is duplicated deliberately and pinned by a
 * fixture the api's layout produced (`secret-cipher.spec.ts`). Change one side
 * and the other must change in the same breath.
 *
 * It only works with the SAME `SECRET_ENCRYPTION_KEY` eventa-api uses. A
 * different key does not decrypt garbage — the GCM tag check throws — and the
 * sync records "could not be read" instead.
 *
 * `decrypt` is what runs; `encrypt` is here for the specs and the e2e seed,
 * which must produce exactly what the api stores.
 */
@Injectable()
export class SecretCipher {
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const encoded: string = config.getOrThrow('SECRET_ENCRYPTION_KEY', {
      infer: true,
    });
    this.key = Buffer.from(encoded, 'base64');
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(payload: Buffer): string {
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = payload.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      'utf8',
    );
  }
}
