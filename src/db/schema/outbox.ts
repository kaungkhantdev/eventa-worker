import { bigint, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `outbox_events` — the transactional outbox its relay
// publishes to RabbitMQ. eventa-api OWNS the table.
//
// This service WRITES it in two places, both for the same reason — a state
// change and the message about it must commit together, exactly as they do
// when the API makes the same change, and writing the same row the API writes
// means both reach the same handler, with the same retries:
//
// - when the expiry sweep passes a lapsed waitlist offer to the next person
//   (US-REG-04), the new offer and the email about it;
// - when a scheduled announcement falls due (US-MSG-04/05), marking it sent
//   and the broadcast that delivers it.
export const outboxEvents = pgTable('outbox_events', {
  id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  organizationId: bigint({ mode: 'number' }).notNull(),
  aggregateType: text().notNull(),
  aggregateId: text().notNull(),
  routingKey: text().notNull(),
  payload: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }),
  publishedAt: timestamp({ withTimezone: true }),
});
