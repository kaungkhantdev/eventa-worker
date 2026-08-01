import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { EventPublishedHandler } from './event-published.handler';

const ctx: MessageContext = {
  routingKey: 'events.published',
  messageId: '1',
  correlationId: 'c1',
};

const rawEvent = {
  version: 1,
  organizationId: 7,
  eventId: 'e1',
  slug: 'bangkok-summit-2026',
  name: 'Bangkok Summit 2026',
  publishedBy: 'u1',
  occurredAt: '2026-07-31T00:00:00.000Z',
};

describe('EventPublishedHandler', () => {
  let handler: EventPublishedHandler;

  beforeEach(() => {
    handler = new EventPublishedHandler();
  });

  it('subscribes to the events.published routing key', () => {
    expect(handler.routingKey).toBe('events.published');
  });

  it('consumes a well-formed publication event', async () => {
    await expect(handler.handle(rawEvent, ctx)).resolves.toBeUndefined();
  });

  it('rejects a malformed event (tolerant reader still needs the core fields)', async () => {
    await expect(handler.handle({ eventId: 'e1' }, ctx)).rejects.toBeDefined();
  });
});
