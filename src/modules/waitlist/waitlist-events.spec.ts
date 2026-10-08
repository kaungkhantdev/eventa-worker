import {
  WAITLIST_OFFERED,
  WAITLIST_OFFER_EXPIRED,
  offerExpiredEvent,
  payUrlFor,
  waitlistOfferedEvent,
} from './waitlist-events';

const NOW = new Date('2026-08-01T03:00:00.000Z');
const UNTIL = new Date('2026-08-02T03:00:00.000Z');
const ENTRY = {
  organizationId: 7,
  orderId: 'o-1',
  reference: 'ORD-AAAA1111',
  eventId: 'e-1',
  buyerEmail: 'anan@example.test',
  buyerName: 'Anan',
};

describe('waitlist outbox events (US-REG-04)', () => {
  it('offers the seat in the same shape eventa-api does', () => {
    // Both the API and this sweep make offers, and one handler reads both.
    const event = waitlistOfferedEvent({
      ...ENTRY,
      ticketTypeName: 'General',
      ticketCount: 2,
      totalSatang: 210_000,
      currency: 'THB',
      offerExpiresAt: UNTIL,
      payUrl: 'https://web.test/my/tickets/orders/o-1',
      occurredAt: NOW,
    });
    expect(event).toEqual({
      organizationId: 7,
      aggregateType: 'order',
      aggregateId: 'o-1',
      routingKey: WAITLIST_OFFERED,
      payload: {
        version: 1,
        ...ENTRY,
        ticketTypeName: 'General',
        ticketCount: 2,
        totalSatang: 210_000,
        currency: 'THB',
        offerExpiresAt: UNTIL.toISOString(),
        payUrl: 'https://web.test/my/tickets/orders/o-1',
        occurredAt: NOW.toISOString(),
      },
    });
  });

  it('tells a lapsed offer’s owner it is over', () => {
    const event = offerExpiredEvent({ ...ENTRY, occurredAt: NOW });
    expect(event.routingKey).toBe(WAITLIST_OFFER_EXPIRED);
    expect(event.payload).toEqual({
      version: 1,
      ...ENTRY,
      occurredAt: NOW.toISOString(),
    });
  });

  it('links to the order page the offer is paid on, absolutely', () => {
    // Relative is inert in a mail client; a trailing slash must not double.
    expect(payUrlFor('https://web.test/', 'o-1')).toBe(
      'https://web.test/my/tickets/orders/o-1',
    );
  });
});
