import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/** Prefix so every series is attributable in a shared Prometheus. */
const PREFIX = 'eventa_';

/**
 * Buckets for handler duration, in seconds.
 *
 * Skewed short because most handlers are a write and an ack; the long tail is
 * the ones that talk to SMTP or a calendar API, and 10s is where "slow" turns
 * into "something is wrong".
 */
const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10];

/**
 * What this worker tells Prometheus (devops-observability-sre.md §2).
 *
 * One metric here exists because of a specific outage: `consumer_attached`. The
 * worker ran for a day with a dead AMQP channel while every other signal stayed
 * green, and no amount of process-level monitoring would have caught it — the
 * process was fine. What was missing was anyone asking whether it was still
 * doing the job.
 *
 * Deliberately no `organization_id` label anywhere. Metric labels are a
 * cartesian product, one tenant is one more time series per metric per label
 * combination, and a per-tenant breakdown belongs in a query against the data —
 * not in a gauge that grows without bound as the product sells.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** 1 while attached to the work queue, 0 while detached. The outage signal. */
  private readonly consumerAttached = new Gauge({
    name: `${PREFIX}consumer_attached`,
    help: 'Whether this worker is attached to its queue (1) or not (0)',
    registers: [this.registry],
  });

  private readonly messagesHandled = new Counter({
    name: `${PREFIX}messages_handled_total`,
    help: 'Messages dispatched to a handler, by routing key and outcome',
    labelNames: ['routing_key', 'outcome'] as const,
    registers: [this.registry],
  });

  private readonly handlerDuration = new Histogram({
    name: `${PREFIX}handler_duration_seconds`,
    help: 'Wall time a handler took, by routing key',
    labelNames: ['routing_key'] as const,
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });

  /**
   * Email specifically, because it is the product's most visible side effect —
   * "the attendee never got their ticket" is a support ticket, not a graph.
   */
  private readonly emails = new Counter({
    name: `${PREFIX}emails_total`,
    help: 'Emails handed to the provider, by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  constructor() {
    // Heap, event-loop lag, GC — the ordinary "is this process struggling"
    // signals, on the same registry so one scrape gets everything.
    collectDefaultMetrics({ register: this.registry, prefix: PREFIX });
    this.consumerAttached.set(0);
  }

  setConsumerAttached(attached: boolean): void {
    this.consumerAttached.set(attached ? 1 : 0);
  }

  /** `outcome`: `ok` handled, `retried` scheduled again, `parked` dead-lettered. */
  recordHandled(routingKey: string, outcome: 'ok' | 'retried' | 'parked'): void {
    this.messagesHandled.inc({ routing_key: routingKey, outcome });
  }

  recordHandlerDuration(routingKey: string, seconds: number): void {
    this.handlerDuration.observe({ routing_key: routingKey }, seconds);
  }

  recordEmail(outcome: 'sent' | 'failed'): void {
    this.emails.inc({ outcome });
  }

  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
