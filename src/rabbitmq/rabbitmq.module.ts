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
  // The consumer is exported so the health module can ask whether this worker
  // is actually attached — the question a liveness probe has to answer.
  exports: [RabbitConnection, ConsumerService],
})
export class RabbitmqModule {}
