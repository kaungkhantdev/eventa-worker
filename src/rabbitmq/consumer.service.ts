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
import { isRetryable } from './failure';
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
 * How long to wait before each redelivery, and — by its length — how many
 * attempts a message gets before it parks in the dead-letter queue.
 *
 * Roughly twelve minutes in total, which covers the failures that fix
 * themselves (a restarting database, a greylisting mail server, a brief network
 * partition) without holding a message so long that a human never looks at it.
 * A failure that outlives the ladder wants a person, not another attempt.
 */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;

/** AMQP's nameless exchange: routes by queue name, so no binding is needed. */
const DEFAULT_EXCHANGE = '';

/** Which attempt this delivery is, from the header the last retry stamped. */
function attemptOf(headers: Record<string, unknown>): number {
  const attempt = Number(headers['x-attempt'] ?? 0);
  return Number.isFinite(attempt) && attempt > 0 ? attempt : 0;
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

    // One holding pen per rung. A message published here sits for the queue's
    // TTL with no consumer, expires, and is dead-lettered straight back to the
    // work queue — which is how RabbitMQ does a delay without a scheduler.
    for (const delayMs of RETRY_DELAYS_MS) {
      await channel.assertQueue(this.retryQueue(delayMs), {
        durable: true,
        messageTtl: delayMs,
        deadLetterExchange: DEFAULT_EXCHANGE,
        deadLetterRoutingKey: this.queue,
      });
    }
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
    const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
    const ctx: MessageContext = {
      // A retried message comes back off a delay queue, so its routing key is
      // the work queue's rather than the event's. The original is carried in a
      // header, or the handler could never be found again.
      routingKey: asString(headers['x-routing-key']) ?? msg.fields.routingKey,
      messageId: asString(msg.properties.messageId),
      correlationId: asString(msg.properties.correlationId),
    };
    try {
      await this.dispatch(msg, ctx);
      channel.ack(msg);
    } catch (err) {
      this.settleFailure(channel, msg, ctx, headers, err);
    }
  }

  /**
   * Try again later, or park it.
   *
   * Every failure used to be one nack straight to the dead-letter queue, which
   * treated a thirty-second SMTP outage exactly like a payload that will never
   * parse — and destroyed a signup's only verification email.
   */
  private settleFailure(
    channel: AmqpChannel,
    msg: ConsumeMessage,
    ctx: MessageContext,
    headers: Record<string, unknown>,
    err: unknown,
  ): void {
    const attempt = attemptOf(headers) + 1;
    const delayMs = RETRY_DELAYS_MS[attempt - 1];

    if (delayMs === undefined || !isRetryable(err)) {
      this.logger.error(
        { err, ...ctx, attempt },
        'Handler failed — parking in the dead-letter queue',
      );
      channel.nack(msg, false, false); // → DLX/DLQ, no requeue
      return;
    }

    try {
      channel.publish(DEFAULT_EXCHANGE, this.retryQueue(delayMs), msg.content, {
        ...msg.properties,
        headers: {
          ...headers,
          'x-attempt': attempt,
          'x-routing-key': ctx.routingKey,
        },
      });
    } catch (publishErr) {
      // The delayed copy could not be made, so the original is all there is —
      // park it rather than ack a message whose work has not been done.
      this.logger.error(
        { err: publishErr, ...ctx, attempt },
        'Could not schedule a retry — parking instead',
      );
      channel.nack(msg, false, false);
      return;
    }

    this.logger.warn(
      { err, ...ctx, attempt, delayMs },
      'Handler failed — retrying after a delay',
    );
    // Acked only now: the delayed copy exists, so the original is redundant.
    channel.ack(msg);
  }

  /** `eventa.worker.retry.5000` — holds a message for its TTL, then returns it. */
  private retryQueue(delayMs: number): string {
    return `${this.queue}.retry.${delayMs}`;
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
