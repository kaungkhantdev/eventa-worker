import { bigint, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// MIRROR of eventa-api's `outbox_events` — the transactional outbox its relay
// publishes to RabbitMQ. eventa-api OWNS the table.
//
// This service WRITES it in one place: when the expiry sweep passes a lapsed
// waitlist offer to the next person (US-REG-04), the new offer and the email
// about it must commit together, exactly as they do when an organizer makes
// the offer through the API. Writing the same row the API writes means both
// offers reach the same handler, with the same retries.
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
