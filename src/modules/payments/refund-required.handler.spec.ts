import type { EmailProvider } from '../../common/email/email.provider';
import type { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { RefundContext } from './payments.repository';
import type { PaymentsRepository } from './payments.repository';
import { RefundRequiredHandler } from './refund-required.handler';

const ORG = 7;
const BAHT = 100;

const ctx: MessageContext = {
  routingKey: 'payment.refund_required',
  messageId: 'msg-1',
  correlationId: 'corr-1',
};

const payload = (o: Record<string, unknown> = {}) => ({
  version: 1,
  organizationId: ORG,
  orderId: 'o-1',
  reference: 'ORD-7K2M9QX4',
  eventId: 'e-1',
  buyerEmail: 'anan@example.test',
  amountSatang: 1_880 * BAHT,
  currency: 'THB',
  reason: 'duplicate_payment',
  occurredAt: '2026-08-01T00:00:00Z',
  ...o,
});

const context = (o: Partial<RefundContext> = {}): RefundContext => ({
  eventName: 'Bangkok Tech Week',
  organizerEmail: 'organizer@acme.test',
  locale: 'en',
  ...o,
});

describe('RefundRequiredHandler (US-FIN-02 trigger)', () => {
  let email: jest.Mocked<EmailProvider>;
  let repo: jest.Mocked<PaymentsRepository>;
  let idempotency: jest.Mocked<IdempotencyService>;
  let handler: RefundRequiredHandler;

  beforeEach(() => {
    email = { send: jest.fn().mockResolvedValue(undefined) };
    repo = {
      refundContext: jest.fn().mockResolvedValue(context()),
    } as unknown as jest.Mocked<PaymentsRepository>;
    idempotency = {
      isCompleted: jest.fn().mockResolvedValue(false),
      markCompleted: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IdempotencyService>;
    handler = new RefundRequiredHandler(email, repo, idempotency);
  });

  const handle = (o: Record<string, unknown> = {}) =>
    handler.handle(payload(o), ctx);

  it('binds to the routing key the API publishes', () => {
    expect(handler.routingKey).toBe('payment.refund_required');
  });

  it('tells the ORGANIZER a refund is owed, because only they can issue it', async () => {
    await handle();
    const toOrganizer = email.send.mock.calls
      .map(([m]) => m)
      .find((m) => m.to === 'organizer@acme.test');
    expect(toOrganizer).toBeDefined();
    expect(toOrganizer?.subject).toMatch(/refund/i);
    expect(toOrganizer?.text).toContain('ORD-7K2M9QX4');
    expect(toOrganizer?.text).toContain('฿1,880.00');
  });

  it('tells the BUYER their money is coming back', async () => {
    await handle();
    const toBuyer = email.send.mock.calls
      .map(([m]) => m)
      .find((m) => m.to === 'anan@example.test');
    expect(toBuyer).toBeDefined();
    expect(toBuyer?.text).toContain('ORD-7K2M9QX4');
  });

  it('writes the buyer’s notice in the event’s language', async () => {
    repo.refundContext.mockResolvedValue(context({ locale: 'th' }));
    await handle();
    const toBuyer = email.send.mock.calls
      .map(([m]) => m)
      .find((m) => m.to === 'anan@example.test');
    expect(toBuyer?.text).toMatch(/คืนเงิน/);
  });

  it('still reaches the organizer when the workspace has no contact address', async () => {
    // No one to alert is the one outcome that loses the money silently, so this
    // must be loud rather than a quiet return.
    repo.refundContext.mockResolvedValue(context({ organizerEmail: null }));
    await expect(handle()).rejects.toThrow(/contact/i);
    expect(idempotency.markCompleted).not.toHaveBeenCalled();
  });

  it('records completion only after both notices are away', async () => {
    const order: string[] = [];
    email.send.mockImplementation(() => {
      order.push('send');
      return Promise.resolve();
    });
    idempotency.markCompleted.mockImplementation(() => {
      order.push('mark');
      return Promise.resolve();
    });
    await handle();
    expect(order).toEqual(['send', 'send', 'mark']);
  });

  it('does not notify twice on redelivery', async () => {
    idempotency.isCompleted.mockResolvedValue(true);
    await handle();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('names the reason so finance knows which kind of refund this is', async () => {
    await handle({ reason: 'seats_unavailable' });
    const toOrganizer = email.send.mock.calls
      .map(([m]) => m)
      .find((m) => m.to === 'organizer@acme.test');
    // Rendered as prose, not as the raw enum the API sends.
    expect(toOrganizer?.text).toMatch(/seats were taken/i);
    expect(toOrganizer?.text).not.toMatch(/seats_unavailable/);
  });

  it('falls back to a readable line for a reason it does not know', async () => {
    await handle({ reason: 'something_new_from_the_api' });
    const toOrganizer = email.send.mock.calls
      .map(([m]) => m)
      .find((m) => m.to === 'organizer@acme.test');
    expect(toOrganizer?.text).not.toMatch(/undefined|null/);
    // Underscores become spaces so an unmapped code still reads as words.
    expect(toOrganizer?.text).toMatch(/something new from the api/i);
  });
});
