import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import type { ConsumeMessage } from 'amqplib';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { Env } from '../config/env.validation';
import {
  isMessageHandler,
  type MessageContext,
  type MessageHandler,
} from './message-handler.interface';
import { type AmqpChannel, RabbitConnection } from './rabbit.connection';

/** amqplib types message properties as `any`; coerce to a clean string|undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Consumes the worker queue and dispatches each message to the handler bound to
 * its routing key. At-least-once + idempotent (dedupe on the *completed* message id,
 * recorded only after the handler succeeds); tolerant reader (handler validates);
 * failures are dead-lettered (nack → DLX/DLQ), never hot-looped.
 */
@Injectable()
export class ConsumerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConsumerService.name);
  private readonly handlers = new Map<string, MessageHandler>();

  constructor(
    private readonly rabbit: RabbitConnection,
    private readonly config: ConfigService<Env, true>,
    private readonly idempotency: IdempotencyService,
    private readonly discovery: DiscoveryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.registerHandlers();
    const channel = await this.rabbit.connect(
      this.config.get('RABBITMQ_URL', { infer: true }),
    );
    await this.setupTopology(channel);
    await channel.consume(
      this.queue,
      (msg) => void this.onMessage(channel, msg),
    );
    this.logger.log(
      `Consuming "${this.queue}" — ${this.handlers.size} handler(s): ${[...this.handlers.keys()].join(', ')}`,
    );
  }

  private registerHandlers(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (isMessageHandler(instance)) {
        this.handlers.set(instance.routingKey, instance);
      }
    }
  }

  private get exchange(): string {
    return this.config.get('RABBITMQ_EXCHANGE', { infer: true });
  }

  private get queue(): string {
    return this.config.get('RABBITMQ_QUEUE', { infer: true });
  }

  private async setupTopology(channel: AmqpChannel): Promise<void> {
    const dlx = `${this.exchange}.dlx`;
    const dlq = `${this.queue}.dlq`;
    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    await channel.assertExchange(dlx, 'fanout', { durable: true });
    await channel.assertQueue(dlq, { durable: true });
    await channel.bindQueue(dlq, dlx, '');
    await channel.assertQueue(this.queue, {
      durable: true,
      deadLetterExchange: dlx,
    });
    for (const routingKey of this.handlers.keys()) {
      await channel.bindQueue(this.queue, this.exchange, routingKey);
    }
    await channel.prefetch(
      this.config.get('RABBITMQ_PREFETCH', { infer: true }),
    );
  }

  private async onMessage(
    channel: AmqpChannel,
    msg: ConsumeMessage | null,
  ): Promise<void> {
    if (!msg) return;
    const ctx: MessageContext = {
      routingKey: msg.fields.routingKey,
      messageId: asString(msg.properties.messageId),
      correlationId: asString(msg.properties.correlationId),
    };
    try {
      await this.dispatch(msg, ctx);
      channel.ack(msg);
    } catch (err) {
      this.logger.error({ err, ...ctx }, 'Handler failed — dead-lettering');
      channel.nack(msg, false, false); // → DLX/DLQ, no requeue
    }
  }

  private async dispatch(
    msg: ConsumeMessage,
    ctx: MessageContext,
  ): Promise<void> {
    const handler = this.handlers.get(ctx.routingKey);
    if (!handler) {
      this.logger.warn({ routingKey: ctx.routingKey }, 'No handler — dropping');
      return;
    }
    if (ctx.messageId && (await this.idempotency.isCompleted(ctx.messageId))) {
      this.logger.debug({ ...ctx }, 'Already processed — skipping');
      return;
    }
    const raw: unknown = JSON.parse(msg.content.toString('utf8'));
    await handler.handle(raw, ctx);
    // Record completion only AFTER the handler succeeds: an interrupted run (no
    // catch) leaves the message un-acked and un-marked, so it is re-processed on
    // redelivery instead of being skipped-and-acked (which would drop its work).
    if (ctx.messageId) await this.idempotency.markCompleted(ctx.messageId);
    this.logger.log({ ...ctx }, 'Message handled');
  }
}
