import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Global on purpose. Instrumentation is cross-cutting — the consumer, the email
 * provider and anything added later all record into the same registry — and
 * threading a metrics import through every domain module would be ceremony
 * around a single shared object.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
