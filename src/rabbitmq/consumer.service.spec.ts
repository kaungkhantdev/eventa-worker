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

/** Fake ack/nack recorder standing in for an amqplib channel. */
function fakeChannel(): jest.Mocked<Pick<AmqpChannel, 'ack' | 'nack'>> {
  return { ack: jest.fn(), nack: jest.fn() };
}

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
    {} as unknown as ConfigService<Env, true>,
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

    // Delivery #1: handler dies -> dead-lettered, NOT marked completed.
    const first = fakeChannel();
    await invoke(service, first, message(payload));
    expect(first.nack).toHaveBeenCalledWith(expect.anything(), false, false);
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
