import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * `GET /metrics` — the Prometheus scrape endpoint.
 *
 * Unauthenticated, like the health probes beside it, and for the same reason:
 * it is bound to the worker's internal port, which is reachable from the
 * cluster and not from the internet. Nothing here is a secret — counters,
 * gauges and process statistics — but note that is a property of what is
 * EXPOSED, not of the endpoint: a metric labelled with an email address or a
 * tenant name would leak through it just fine. See MetricsService on why there
 * are no per-tenant labels.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  // Prometheus' own content type; without it a scrape is still parsed, but
  // every tool that sniffs the type shows the page as plain prose.
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}
