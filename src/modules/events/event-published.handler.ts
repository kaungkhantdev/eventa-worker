import { Injectable, Logger } from '@nestjs/common';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import {
  EVENTS_PUBLISHED,
  type EventPublishedEvent,
  eventPublishedSchema,
} from './event-published.schema';

/**
 * Handles `events.published` (US-EVT-07). Binding this key means the publish notice
 * is consumed + acked (not dropped by the exchange) and validated. Delivering the
 * team's "Event published" notification is deferred until a workspace-members
 * read-model exists — the payload carries no recipient addresses today — so for now
 * the publication is recorded to the structured log as that seam.
 */
@Injectable()
export class EventPublishedHandler extends ValidatedHandler<EventPublishedEvent> {
  readonly routingKey = EVENTS_PUBLISHED;
  protected readonly schema = eventPublishedSchema;
  private readonly logger = new Logger(EventPublishedHandler.name);

  protected process(
    payload: EventPublishedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        eventId: payload.eventId,
        slug: payload.slug,
      },
      `Event published: ${payload.name}`,
    );
    return Promise.resolve();
  }
}
