import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import * as amqp from 'amqplib';
import { reconnectDelayMs } from './reconnect-backoff';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
export type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

/** Re-establishes everything that lives on a channel: topology, then consumers. */
export type ChannelReady = (channel: AmqpChannel) => Promise<void>;

/** Called the moment the channel goes, so gauges stop claiming otherwise. */
export type ChannelLost = () => void;

/**
 * Owns the single AMQP connection + channel, and keeps it.
 *
 * The keeping is the point. This used to connect once at boot and, on 'close',
 * clear the channel and log a warning — leaving a live process consuming
 * nothing, for as long as nobody noticed. `/health/live` stayed green
 * throughout, so nobody did: an entire day of confirmation and reset emails
 * queued behind a worker that looked healthy.
 *
 * A dropped connection is now a normal event to recover from, not a terminal
 * one. Every reconnect re-runs `onReady`, because a channel is where the
 * topology assertions and the consumer registration live — a new channel with
 * neither is a connection that is up and still delivers nothing, which is the
 * same outage wearing a healthier face.
 */
@Injectable()
export class RabbitConnection implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitConnection.name);
  private connection?: AmqpConnection;
  private channel?: AmqpChannel;
  private url?: string;
  private onReady?: ChannelReady;
  private onLost?: ChannelLost;
  private attempt = 0;
  private retryTimer?: NodeJS.Timeout;
  /** When the channel was lost, so liveness can tell a blip from an outage. */
  private downSince?: number;
  /** Set by onModuleDestroy, so a deliberate shutdown is not fought with retries. */
  private closing = false;

  /**
   * Connect and stay connected. `onReady` runs on the first channel and on
   * every replacement, and must be safe to run more than once — asserting
   * topology and consuming are both idempotent.
   */
  async connect(
    url: string,
    onReady?: ChannelReady,
    onLost?: ChannelLost,
  ): Promise<AmqpChannel> {
    this.url = url;
    if (onReady) this.onReady = onReady;
    if (onLost) this.onLost = onLost;
    if (this.channel) return this.channel;

    const connection = await amqp.connect(url);
    connection.on('error', (err: unknown) =>
      // Logged, not acted on: amqplib always follows an error with a 'close',
      // and reconnecting from both would race two connections into existence.
      this.logger.error({ err }, 'RabbitMQ connection error'),
    );
    connection.on('close', () => {
      this.channel = undefined;
      this.connection = undefined;
      this.downSince ??= Date.now();
      this.onLost?.();
      if (this.closing) return;
      this.logger.warn('RabbitMQ connection closed — reconnecting');
      this.scheduleReconnect();
    });

    this.connection = connection;
    this.channel = await connection.createChannel();
    this.attempt = 0;
    this.downSince = undefined;
    return this.channel;
  }

  /** How long the channel has been gone, in ms; 0 while it is up. */
  downForMs(now: number = Date.now()): number {
    if (this.downSince === undefined) return 0;
    return Math.max(0, now - this.downSince);
  }

  /**
   * Whether messages can actually flow.
   *
   * A channel is the honest answer, not a connection: the consumer is
   * registered on a channel, and a connection whose channel has gone is one
   * that delivers nothing.
   */
  get isConnected(): boolean {
    return this.channel !== undefined;
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || this.closing) return;
    this.attempt += 1;
    const delay = reconnectDelayMs(this.attempt);
    this.logger.warn(
      { attempt: this.attempt, delayMs: delay },
      'Scheduling RabbitMQ reconnect',
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.reconnect();
    }, delay);
    // Never hold the process open on the retry alone: a worker whose only
    // remaining work is waiting for a broker should still exit on SIGTERM.
    this.retryTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.closing || !this.url) return;
    try {
      const channel = await this.connect(this.url);
      // The channel is useless until the topology and consumers are back on it.
      // If this throws, the catch below schedules another attempt rather than
      // leaving a connected-but-deaf worker behind.
      await this.onReady?.(channel);
      this.logger.log('RabbitMQ reconnected');
    } catch (err) {
      this.channel = undefined;
      this.connection = undefined;
      this.logger.error({ err }, 'RabbitMQ reconnect failed');
      this.scheduleReconnect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try {
      await this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.connection?.close();
    } catch {
      /* ignore */
    }
  }
}
