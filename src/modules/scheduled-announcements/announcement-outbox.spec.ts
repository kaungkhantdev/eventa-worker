import {
  EVENTS_ATTENDEES_EMAIL_REQUESTED,
  attendeesEmailRequestedSchema,
} from '../events/attendees-email.schema';
import { attendeesEmailRequestedOutbox } from './announcement-outbox';

const NOW = new Date('2026-08-05T03:00:00.000Z');
const DUE = {
  organizationId: 7,
  eventId: 'e-1',
  subject: 'Doors at 6',
  body: 'See you in Hall B',
  requestedByUserId: 'u-1',
  recipientCount: 2,
  occurredAt: NOW,
};

describe('the send a scheduled announcement writes when it is due (US-MSG-04)', () => {
  it('is the row eventa-api writes for a send-now', () => {
    // One handler reads both, and cannot tell them apart — so the delivery,
    // the per-recipient ledger and the delivery log are the same either way.
    expect(attendeesEmailRequestedOutbox(DUE)).toEqual({
      organizationId: 7,
      aggregateType: 'event',
      aggregateId: 'e-1',
      routingKey: EVENTS_ATTENDEES_EMAIL_REQUESTED,
      payload: {
        version: 1,
        organizationId: 7,
        eventId: 'e-1',
        subject: 'Doors at 6',
        message: 'See you in Hall B',
        requestedByUserId: 'u-1',
        recipientCount: 2,
        occurredAt: '2026-08-05T03:00:00.000Z',
      },
    });
  });

  it('is read by the handler’s own schema', () => {
    const { payload } = attendeesEmailRequestedOutbox(DUE);

    expect(attendeesEmailRequestedSchema.safeParse(payload).success).toBe(true);
  });

  it('carries no recipient address', () => {
    // The handler resolves the attendees when it sends; addresses on the bus
    // would be attendee PII through a broker, stale by delivery.
    const { payload } = attendeesEmailRequestedOutbox(DUE);

    expect(JSON.stringify(payload)).not.toMatch(/@/);
  });

  it('still goes when its author has since been removed', () => {
    // `sent_by_user_id` is ON DELETE SET NULL. A scheduled announcement whose
    // author's account was deleted in the meantime is still the workspace's
    // announcement — refusing it at the consumer would dead-letter it silently.
    const { payload } = attendeesEmailRequestedOutbox({
      ...DUE,
      requestedByUserId: null,
    });

    const parsed = attendeesEmailRequestedSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.requestedByUserId).toBeNull();
  });
});
