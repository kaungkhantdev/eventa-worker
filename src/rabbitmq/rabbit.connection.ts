import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import * as amqp from 'amqplib';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
export type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

/** Owns the single AMQP connection + channel; the consumer asserts topology on it. */
@Injectable()
export class RabbitConnection implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitConnection.name);
  private connection?: AmqpConnection;
  private channel?: AmqpChannel;

  async connect(url: string): Promise<AmqpChannel> {
    if (this.channel) return this.channel;
    const connection = await amqp.connect(url);
    connection.on('error', (err: unknown) =>
      this.logger.error({ err }, 'RabbitMQ connection error'),
    );
    connection.on('close', () => {
      this.channel = undefined;
      this.logger.warn('RabbitMQ connection closed');
    });
    this.connection = connection;
    this.channel = await connection.createChannel();
    return this.channel;
  }

  get isConnected(): boolean {
    return this.channel !== undefined;
  }

  async onModuleDestroy(): Promise<void> {
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
