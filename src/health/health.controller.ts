import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

/**
 * k8s probes for the worker.
 * - `GET /health/live`  — this process is doing its job (503 if not).
 * - `GET /health/ready` — DB + RabbitMQ reachable (503 if not).
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness, meaning "consuming" rather than "the event loop still turns".
   *
   * It used to return ok unconditionally, and that is exactly how a worker sat
   * for a day with a dead AMQP channel while every probe agreed it was fine.
   * A worker that is not attached to its queue does no work and cannot recover
   * on its own past the reconnect budget — a restart is the correct remedy, and
   * a failing liveness probe is how a supervisor is told to apply it.
   *
   * Deliberately tolerant of a brief drop: `liveness()` reports failure only
   * once reconnection has been trying for longer than any blip would take, so
   * a one-second broker bounce is not answered with a container restart.
   */
  @Get('live')
  live(@Res({ passthrough: true }) res: Response) {
    const result = this.health.liveness();
    res.status(
      result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return result;
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.health.readiness();
    res.status(
      result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return result;
  }
}
