import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ConsumerService } from './consumer.service';
import { RabbitConnection } from './rabbit.connection';

/**
 * RabbitMQ consumer. DiscoveryModule lets the consumer find every provider that
 * implements MessageHandler (across domain modules) without importing them —
 * so infrastructure never depends on the domain modules.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [RabbitConnection, ConsumerService],
  exports: [RabbitConnection],
})
export class RabbitmqModule {}
