import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { Env } from '../../config/env.validation';
import { REDIS } from './idempotency.constants';

/** Redis value stored for a set flag — presence is what matters, not the value. */
const FLAG = '1';
/** Key prefix for the message-level "processing completed" marker. */
const COMPLETED_PREFIX = 'evt:';
/** Key prefix for a per-message hash recording which recipients were delivered to. */
const LEDGER_PREFIX = 'evt:sent:';

/**
 * A per-message record of which recipients a fan-out handler has already delivered
 * to. Consulted by `deliverToEach` so a re-processed (redelivered / DLQ-replayed)
 * broadcast neither re-sends the head nor skips the un-sent tail.
 */
export interface SentLedger {
  wasSent(recipientKey: string): Promise<boolean>;
  markSent(recipientKey: string): Promise<void>;
}

/**
 * Idempotency for at-least-once consumers, recorded **after** the side effect so an
 * interrupted run (crash / OOM / SIGKILL / consumer_timeout — no catch) is
 * re-processed on redelivery rather than skipped. `markCompleted` records a message
 * as fully handled (a later redelivery of the same id is then a no-op); the
 * `recipientLedger` gives fan-out handlers exactly-once-per-recipient delivery across
 * those re-processings. All markers share the `IDEMPOTENCY_TTL_SECONDS` dedupe window.
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

  /** True once `markCompleted` has recorded this id as fully processed. */
  async isCompleted(messageId: string): Promise<boolean> {
    return (await this.redis.exists(`${COMPLETED_PREFIX}${messageId}`)) === 1;
  }

  /** Record a message as fully processed. Call only after the handler succeeds. */
  async markCompleted(messageId: string): Promise<void> {
    const key = `${COMPLETED_PREFIX}${messageId}`;
    await this.redis.set(key, FLAG, 'EX', this.ttlSeconds);
  }

  /** A ledger scoped to one message id, backing per-recipient dedupe. */
  recipientLedger(messageId: string): SentLedger {
    const key = `${LEDGER_PREFIX}${messageId}`;
    return {
      wasSent: async (recipientKey) =>
        (await this.redis.hexists(key, recipientKey)) === 1,
      markSent: async (recipientKey) => {
        await this.redis.hset(key, recipientKey, FLAG);
        await this.redis.expire(key, this.ttlSeconds);
      },
    };
  }
}
