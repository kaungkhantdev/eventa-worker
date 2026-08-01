import { Module } from '@nestjs/common';
import { RabbitmqModule } from '../rabbitmq/rabbitmq.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [RabbitmqModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
