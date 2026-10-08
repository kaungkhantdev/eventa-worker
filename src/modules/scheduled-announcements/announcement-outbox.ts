import { EVENTS_ATTENDEES_EMAIL_REQUESTED } from '../events/attendees-email.schema';

/** A due announcement, as the sweep hands it to the outbox. */
export interface DueAnnouncementSend {
  organizationId: number;
  eventId: string;
  subject: string;
  body: string;
  /** Null when the author's account has since been removed — it still goes. */
  requestedByUserId: string | null;
  /** Distinct confirmed attendees at the moment it goes. */
  recipientCount: number;
  occurredAt: Date;
}

/** One row for the transactional outbox, as eventa-api's `OutboxEventInput`. */
export interface AnnouncementOutboxEvent {
  organizationId: number;
  aggregateType: 'event';
  aggregateId: string;
  routingKey: string;
  payload: Record<string, unknown>;
}

/**
 * The send, in EXACTLY the shape eventa-api's `attendeesEmailRequestedEvent`
 * writes for a send-now (US-EVT-14 / US-MSG-04). A scheduled announcement and
 * an immediate one reach the same handler, which cannot tell them apart and
 * must not need to — that is what keeps delivery, the per-recipient ledger and
 * the delivery log identical. Keep the two in step.
 *
 * `message` is the announcement's `body`: the API's name for the column and
 * the event's name for the field differ, and the event's is the contract.
 */
export function attendeesEmailRequestedOutbox(
  send: DueAnnouncementSend,
): AnnouncementOutboxEvent {
  return {
    organizationId: send.organizationId,
    aggregateType: 'event',
    aggregateId: send.eventId,
    routingKey: EVENTS_ATTENDEES_EMAIL_REQUESTED,
    payload: {
      version: 1,
      organizationId: send.organizationId,
      eventId: send.eventId,
      subject: send.subject,
      message: send.body,
      requestedByUserId: send.requestedByUserId,
      recipientCount: send.recipientCount,
      occurredAt: send.occurredAt.toISOString(),
    },
  };
}
