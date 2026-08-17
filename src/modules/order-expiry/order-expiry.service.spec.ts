import type { ConfigService } from '@nestjs/config';
import type { Clock } from '../../common/time/clock';
import type { Env } from '../../config/env.validation';
import type {
  ExpiredOrder,
  OrderExpiryRepository,
} from './order-expiry.repository';
import { OrderExpiryService } from './order-expiry.service';

const NOW = new Date('2026-06-01T00:30:00Z');
const GRACE_MS = 120_000;
const BATCH = 200;

function harness(expired: ExpiredOrder[] = []) {
  const expireLapsed = jest.fn<Promise<ExpiredOrder[]>, [unknown]>(() =>
    Promise.resolve(expired),
  );
  const repo = { expireLapsed } as unknown as OrderExpiryRepository;
  const config = {
    get: (key: keyof Env) =>
      key === 'ORDER_EXPIRY_GRACE_MS' ? GRACE_MS : BATCH,
  } as unknown as ConfigService<Env, true>;
  const clock: Clock = { now: () => NOW };
  return { service: new OrderExpiryService(repo, config, clock), expireLapsed };
}

const order = (id: string): ExpiredOrder => ({
  id,
  organizationId: 7,
  reference: `ORD-${id}`,
});

describe('OrderExpiryService', () => {
  it('sweeps with the configured grace period and batch size', async () => {
    const { service, expireLapsed } = harness();

    await service.sweep();

    expect(expireLapsed).toHaveBeenCalledWith({
      now: NOW,
      graceMs: GRACE_MS,
      limit: BATCH,
    });
  });

  it('reports how many orders it closed', async () => {
    const { service } = harness([order('a'), order('b')]);

    await expect(service.sweep()).resolves.toBe(2);
  });

  it('is quiet when there was nothing to close', async () => {
    const { service } = harness([]);

    await expect(service.sweep()).resolves.toBe(0);
  });

  /**
   * The caller decides what a failure means. The cron swallows it so one bad
   * tick cannot take the worker down; a test or an operator calling `sweep`
   * directly wants to know it failed.
   */
  it('surfaces a failed sweep rather than swallowing it', async () => {
    const { service, expireLapsed } = harness();
    expireLapsed.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.sweep()).rejects.toThrow('connection lost');
  });
});
