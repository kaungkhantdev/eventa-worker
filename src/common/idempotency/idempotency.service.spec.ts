import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { Env } from '../../config/env.validation';
import { IdempotencyService } from './idempotency.service';

const TTL = 3600;

/**
 * Minimal in-memory stand-in for the handful of ioredis commands the service uses,
 * so the unit test needs no live Redis. String keys back the completion marker;
 * hashes back the per-recipient ledger. Return shapes mirror ioredis (exists/hexists
 * yield 0|1, not booleans).
 */
class FakeRedis {
  private readonly strings = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  readonly ttls = new Map<string, number>();

  set(key: string, value: string, _ex: 'EX', ttl: number): Promise<'OK'> {
    this.strings.set(key, value);
    this.ttls.set(key, ttl);
    return Promise.resolve('OK');
  }

  exists(key: string): Promise<number> {
    return Promise.resolve(this.strings.has(key) ? 1 : 0);
  }

  hset(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const isNew = hash.has(field) ? 0 : 1;
    hash.set(field, value);
    this.hashes.set(key, hash);
    return Promise.resolve(isNew);
  }

  hexists(key: string, field: string): Promise<number> {
    return Promise.resolve(this.hashes.get(key)?.has(field) ? 1 : 0);
  }

  expire(key: string, ttl: number): Promise<number> {
    this.ttls.set(key, ttl);
    return Promise.resolve(1);
  }
}

const configStub = {
  get: () => TTL,
} as unknown as ConfigService<Env, true>;

describe('IdempotencyService', () => {
  let redis: FakeRedis;
  let service: IdempotencyService;

  beforeEach(() => {
    redis = new FakeRedis();
    service = new IdempotencyService(redis as unknown as Redis, configStub);
  });

  describe('completion marker', () => {
    it('reports a fresh message id as not completed', async () => {
      expect(await service.isCompleted('m1')).toBe(false);
    });

    it('reports completed only after markCompleted, keyed per id', async () => {
      await service.markCompleted('m1');
      expect(await service.isCompleted('m1')).toBe(true);
      expect(await service.isCompleted('m2')).toBe(false);
    });

    it('applies the configured TTL to the completion marker', async () => {
      await service.markCompleted('m1');
      expect(redis.ttls.get('evt:m1')).toBe(TTL);
    });
  });

  describe('per-recipient sent ledger', () => {
    it('starts empty and records sends per recipient', async () => {
      const ledger = service.recipientLedger('m1');
      expect(await ledger.wasSent('anan@x.test')).toBe(false);

      await ledger.markSent('anan@x.test');

      expect(await ledger.wasSent('anan@x.test')).toBe(true);
      expect(await ledger.wasSent('ben@x.test')).toBe(false);
    });

    it('scopes the ledger to its message id', async () => {
      await service.recipientLedger('m1').markSent('anan@x.test');
      expect(await service.recipientLedger('m2').wasSent('anan@x.test')).toBe(
        false,
      );
    });

    it('applies the configured TTL to the ledger key', async () => {
      await service.recipientLedger('m1').markSent('anan@x.test');
      expect(redis.ttls.get('evt:sent:m1')).toBe(TTL);
    });
  });
});
