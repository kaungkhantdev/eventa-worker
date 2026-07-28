import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { Env } from '../../config/env.validation';
import { REDIS } from './idempotency.constants';

/**
 * At-least-once dedupe for consumers. `firstSeen` atomically claims a message id
 * (SET NX); a redelivery of an already-processed id returns false and is skipped.
 * On handler failure the claim is released so the message can be reprocessed.
 */
@Injectable()
export class IdempotencyService {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('IDEMPOTENCY_TTL_SECONDS', { infer: true });
  }

  async firstSeen(messageId: string): Promise<boolean> {
    const result = await this.redis.set(
      this.key(messageId),
      '1',
      'EX',
      this.ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async forget(messageId: string): Promise<void> {
    await this.redis.del(this.key(messageId));
  }

  private key(messageId: string): string {
    return `evt:${messageId}`;
  }
}
