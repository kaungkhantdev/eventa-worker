import type { ConfigService } from '@nestjs/config';
import type { DiscoveryService } from '@nestjs/core';
import type { ConsumeMessage } from 'amqplib';
import type { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { Env } from '../config/env.validation';
import { ConsumerService } from './consumer.service';
import type {
  MessageContext,
  MessageHandler,
} from './message-handler.interface';
import type { AmqpChannel } from './rabbit.connection';

const ROUTING_KEY = 'events.attendees_email_requested';

/** Fake ack/nack/publish recorder standing in for an amqplib channel. */
function fakeChannel(): jest.Mocked<
  Pick<AmqpChannel, 'ack' | 'nack' | 'publish'>
> {
  return {
    ack: jest.fn(),
    nack: jest.fn(),
    publish: jest.fn().mockReturnValue(true),
  };
}

const QUEUE = 'eventa.worker';

/** Just enough ConfigService for the queue and exchange names. */
const config = {
  get: (key: string) =>
    ({ RABBITMQ_QUEUE: QUEUE, RABBITMQ_EXCHANGE: 'eventa.events' })[key],
} as unknown as ConfigService<Env, true>;

function message(
  payload: unknown,
  messageId = 'm1',
  routingKey = ROUTING_KEY,
): ConsumeMessage {
  return {
    fields: { routingKey },
    properties: { messageId, correlationId: 'c1' },
    content: Buffer.from(JSON.stringify(payload)),
  } as unknown as ConsumeMessage;
}

/** Build a consumer wired to a stub idempotency + a single seeded handler. */
function buildConsumer(
  idempotency: Partial<IdempotencyService>,
  handler: MessageHandler,
): ConsumerService {
  const service = new ConsumerService(
    {} as never,
    config,
    idempotency as IdempotencyService,
    {} as unknown as DiscoveryService,
  );
  (
    service as unknown as { handlers: Map<string, MessageHandler> }
  ).handlers.set(handler.routingKey, handler);
  return service;
}

const invoke = (service: ConsumerService, channel: unknown, msg: unknown) =>
  (
    service as unknown as {
      onMessage(c: unknown, m: unknown): Promise<void>;
    }
  ).onMessage(channel, msg);

describe('ConsumerService dispatch (idempotency)', () => {
  const payload = { hello: 'world' };

  it('processes a new message, marks it completed, then acks', async () => {
    const idempotency = {
      isCompleted: jest.fn().mockResolvedValue(false),
      markCompleted: jest.fn().mockResolvedValue(undefined),
    };
    const handle = jest.fn<Promise<void>, [unknown, MessageContext]>(() =>
      Promise.resolve(),
    );
    const handler: MessageHandler = { routingKey: ROUTING_KEY, handle };
    const service = buildConsumer(idempotency, handler);
    const channel = fakeChannel();

    await invoke(service, channel, message(payload));

    expect(handle).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({
        messageId: 'm1',
        routingKey: ROUTING_KEY,
      }),
    );
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m1');
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('skips-and-acks a message already marked completed', async () => {
    const idempotency = {
      isCompleted: jest.fn().mockResolvedValue(true),
      markCompleted: jest.fn().mockResolvedValue(undefined),
    };
    const handle = jest.fn(() => Promise.resolve());
    const service = buildConsumer(idempotency, {
      routingKey: ROUTING_KEY,
      handle,
    });
    const channel = fakeChannel();

    await invoke(service, channel, message(payload));

    expect(handle).not.toHaveBeenCalled();
    expect(idempotency.markCompleted).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  // The core of the fix: a run interrupted WITHOUT reaching markCompleted must be
  // re-processed on redelivery — never skipped-and-acked (which silently drops work).
  it('re-processes an interrupted (never-completed) message on redelivery', async () => {
    // markCompleted was never reached on the first attempt, so it stays not-completed.
    const idempotency = {
      isCompleted: jest.fn().mockResolvedValue(false),
      markCompleted: jest.fn().mockResolvedValue(undefined),
    };
    const handle = jest
      .fn<Promise<void>, [unknown, MessageContext]>()
      .mockRejectedValueOnce(new Error('interrupted mid-handler'))
      .mockResolvedValueOnce(undefined);
    const service = buildConsumer(idempotency, {
      routingKey: ROUTING_KEY,
      handle,
    });

    // Delivery #1: handler dies. The work was not done, so it is not marked
    // completed — and it is now scheduled for another attempt rather than
    // dead-lettered outright, which is what the retry ladder changed.
    const first = fakeChannel();
    await invoke(service, first, message(payload));
    expect(first.publish).toHaveBeenCalledTimes(1);
    expect(idempotency.markCompleted).not.toHaveBeenCalled();

    // Delivery #2 (redelivery, same id): re-processed, not skipped.
    const second = fakeChannel();
    await invoke(service, second, message(payload));
    expect(handle).toHaveBeenCalledTimes(2);
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m1');
    expect(second.ack).toHaveBeenCalledTimes(1);
  });

  it('acks and never marks a message with no registered handler', async () => {
    const idempotency = {
      isCompleted: jest.fn().mockResolvedValue(false),
      markCompleted: jest.fn().mockResolvedValue(undefined),
    };
    const handle = jest.fn(() => Promise.resolve());
    const service = buildConsumer(idempotency, {
      routingKey: ROUTING_KEY,
      handle,
    });
    const channel = fakeChannel();

    await invoke(service, channel, message(payload, 'm9', 'unknown.key'));

    expect(handle).not.toHaveBeenCalled();
    expect(idempotency.markCompleted).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });
});

/**
 * The retry ladder (see failure.ts for what counts as retryable).
 *
 * Before this existed, every throw was one nack straight to the dead-letter
 * queue. A thirty-second SMTP outage therefore destroyed a signup's only
 * verification email — which is exactly what happened.
 */
describe('ConsumerService retry ladder', () => {
  const payload = { to: 'a@b.test' };

  function failingConsumer(err: unknown) {
    const idempotency = {
      isCompleted: jest.fn().mockResolvedValue(false),
      markCompleted: jest.fn().mockResolvedValue(undefined),
    };
    return buildConsumer(idempotency, {
      routingKey: ROUTING_KEY,
      handle: jest.fn().mockRejectedValue(err),
    });
  }

  /** The message as it comes back round, carrying its attempt count. */
  function retried(attempt: number): ConsumeMessage {
    return {
      fields: { routingKey: QUEUE },
      properties: {
        messageId: 'm1',
        correlationId: 'c1',
        headers: { 'x-attempt': attempt, 'x-routing-key': ROUTING_KEY },
      },
      content: Buffer.from(JSON.stringify(payload)),
    } as unknown as ConsumeMessage;
  }

  it('sends a transient failure to a delay queue instead of the graveyard', async () => {
    const channel = fakeChannel();
    const service = failingConsumer(
      Object.assign(new Error('smtp down'), { code: 'ECONNECTION' }),
    );

    await invoke(service, channel, message(payload));

    expect(channel.nack).not.toHaveBeenCalled();
    // Acked only once the delayed copy is safely published.
    expect(channel.ack).toHaveBeenCalledTimes(1);
    const [exchange, routingKey, , options] = channel.publish.mock.calls[0] as [
      string,
      string,
      Buffer,
      { headers: Record<string, unknown> },
    ];
    expect(exchange).toBe('');
    expect(routingKey).toMatch(/^eventa\.worker\.retry\./);
    expect(options.headers['x-attempt']).toBe(1);
  });

  /**
   * The delay queue dead-letters back to the work queue, so the routing key on
   * the returning message is the queue's, not the event's. Carried in a header
   * or the handler could never be found again.
   */
  it('remembers which event it was across the round trip', async () => {
    const channel = fakeChannel();
    const service = failingConsumer(
      Object.assign(new Error('smtp down'), { code: 'ECONNECTION' }),
    );

    await invoke(service, channel, message(payload));

    const [, , , options] = channel.publish.mock.calls[0] as [
      string,
      string,
      Buffer,
      { headers: Record<string, unknown> },
    ];
    expect(options.headers['x-routing-key']).toBe(ROUTING_KEY);
  });

  it('counts up, and waits longer each time', async () => {
    const channel = fakeChannel();
    const service = failingConsumer(
      Object.assign(new Error('smtp down'), { code: 'ECONNECTION' }),
    );

    await invoke(service, channel, retried(1));
    await invoke(service, channel, retried(2));

    const first = channel.publish.mock.calls[0][1];
    const second = channel.publish.mock.calls[1][1];
    expect(first).not.toBe(second);
    const delayOf = (q: string) => Number(q.split('.').pop());
    expect(delayOf(second)).toBeGreaterThan(delayOf(first));
  });

  // Poison: retrying a payload that cannot parse only delays the diagnosis.
  it('parks a permanent failure immediately, without burning attempts', async () => {
    const channel = fakeChannel();
    const service = failingConsumer(new SyntaxError('not JSON'));

    await invoke(service, channel, message(payload));

    expect(channel.publish).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('parks a message that has exhausted the ladder', async () => {
    const channel = fakeChannel();
    const service = failingConsumer(
      Object.assign(new Error('still down'), { code: 'ECONNECTION' }),
    );

    await invoke(service, channel, retried(99));

    expect(channel.publish).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });
});
