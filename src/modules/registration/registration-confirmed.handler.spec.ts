import type { EmailProvider } from '../../common/email/email.provider';
import type { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { ConfirmationSource } from './registration.repository';
import type { RegistrationRepository } from './registration.repository';
import { RegistrationConfirmedHandler } from './registration-confirmed.handler';

const ORG = 7;
const ORDER_ID = 'o-1';
const BAHT = 100;

const ctx: MessageContext = {
  routingKey: 'registration.confirmed',
  messageId: 'msg-1',
  correlationId: 'corr-1',
};

function payload(o: Record<string, unknown> = {}) {
  return {
    version: 1,
    organizationId: ORG,
    orderId: ORDER_ID,
    reference: 'ORD-7K2M9QX4',
    eventId: 'e-1',
    buyerEmail: 'anan@example.test',
    buyerName: 'Anan',
    ticketCount: 2,
    totalSatang: 1_880 * BAHT,
    vatSatang: 12_300,
    currency: 'THB',
    isOnline: false,
    paid: true,
    occurredAt: '2026-08-01T00:00:00Z',
    ...o,
  };
}

function source(o: Partial<ConfirmationSource> = {}): ConfirmationSource {
  return {
    event: {
      name: 'Bangkok Tech Week',
      startAt: new Date('2026-09-01T02:00:00Z'),
      timezone: 'Asia/Bangkok',
      venueName: 'QSNCC',
      city: 'Bangkok',
      isOnline: false,
      onlineNote: null,
      slug: 'bangkok-tech-week',
      locale: null,
    },
    orgLocale: 'en',
    userLocale: null,
    tickets: [
      { qrToken: 'QR-AAA', holderName: 'Anan', ticketLabel: 'General' },
      { qrToken: 'QR-BBB', holderName: 'Malee', ticketLabel: 'General' },
    ],
    ...o,
  };
}

describe('RegistrationConfirmedHandler (US-MSG-01)', () => {
  let email: jest.Mocked<EmailProvider>;
  let repo: jest.Mocked<RegistrationRepository>;
  let idempotency: jest.Mocked<IdempotencyService>;
  let handler: RegistrationConfirmedHandler;

  beforeEach(() => {
    email = { send: jest.fn().mockResolvedValue(undefined) };
    repo = {
      isMessageActive: jest.fn().mockResolvedValue(true),
      loadConfirmation: jest.fn().mockResolvedValue(source()),
    } as unknown as jest.Mocked<RegistrationRepository>;
    idempotency = {
      isCompleted: jest.fn().mockResolvedValue(false),
      markCompleted: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IdempotencyService>;
    handler = new RegistrationConfirmedHandler(email, repo, idempotency);
  });

  const handle = (o: Record<string, unknown> = {}) =>
    handler.handle(payload(o), ctx);

  it('binds to the routing key the API publishes', () => {
    expect(handler.routingKey).toBe('registration.confirmed');
  });

  it('sends the confirmation with the tickets read LIVE, not from the message', async () => {
    await handle();
    // The buyer's email goes in too — their own language preference is looked
    // up from it, and hardcoding null there would silently ignore AC4.
    expect(repo.loadConfirmation).toHaveBeenCalledWith(
      ORG,
      ORDER_ID,
      'e-1',
      'anan@example.test',
    );
    const [sent] = email.send.mock.calls[0];
    expect(sent.to).toBe('anan@example.test');
    expect(sent.subject).toContain('Bangkok Tech Week');
    // QR tokens never travel on the bus — they must come from the database.
    expect(sent.text).toContain('QR-AAA');
    expect(sent.text).toContain('QR-BBB');
    expect(sent.text).toContain('ORD-7K2M9QX4');
    expect(sent.text).toContain('฿1,880.00');
  });

  it('records completion only AFTER the email is away', async () => {
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
    expect(order).toEqual(['send', 'mark']);
  });

  it('does not send twice when the message is redelivered', async () => {
    idempotency.isCompleted.mockResolvedValue(true);
    await handle();
    expect(email.send).not.toHaveBeenCalled();
  });

  describe('the organizer’s kill switch', () => {
    it('sends nothing when the message is turned off', async () => {
      repo.isMessageActive.mockResolvedValue(false);
      await handle();
      expect(email.send).not.toHaveBeenCalled();
      expect(repo.loadConfirmation).not.toHaveBeenCalled();
    });

    it('still sends when the workspace has never touched its settings', async () => {
      // An absent row means active — a new workspace must not go silent.
      repo.isMessageActive.mockResolvedValue(true);
      await handle();
      expect(email.send).toHaveBeenCalled();
    });
  });

  describe('language', () => {
    it('uses the attendee’s own preference above everything', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({ userLocale: 'th', orgLocale: 'en' }),
      );
      const [sent] = [await handle()].map(() => email.send.mock.calls[0][0]);
      expect(sent.text).toContain('สวัสดีคุณ Anan');
    });

    it('falls back to the EVENT’s language when the attendee has none', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({
          userLocale: null,
          event: { ...source().event, locale: 'th' },
        }),
      );
      await handle();
      expect(email.send.mock.calls[0][0].text).toContain('สวัสดีคุณ Anan');
    });

    it('falls back to the workspace’s language when neither is set', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({ userLocale: null, orgLocale: 'th' }),
      );
      await handle();
      expect(email.send.mock.calls[0][0].text).toContain('สวัสดีคุณ Anan');
    });
  });

  describe('never send an unfilled field', () => {
    it('omits the venue line rather than printing an empty one', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({
          event: { ...source().event, venueName: null, city: null },
        }),
      );
      await handle();
      const { text } = email.send.mock.calls[0][0];
      expect(text).not.toMatch(/null|undefined/);
      expect(text).not.toMatch(/Where:\s*$/m);
    });

    it('says Online for an online event with no note', async () => {
      repo.loadConfirmation.mockResolvedValue(
        source({
          event: { ...source().event, isOnline: true, venueName: null },
        }),
      );
      await handle();
      expect(email.send.mock.calls[0][0].text).toContain('Online');
    });

    it('calls a free registration free instead of printing ฿0.00', async () => {
      await handle({ paid: false, totalSatang: 0 });
      const { text } = email.send.mock.calls[0][0];
      expect(text).toContain('Free registration');
      expect(text).not.toContain('฿0.00');
    });
  });

  it('refuses to send an order whose tickets have all vanished', async () => {
    // Void/refunded between commit and delivery: an email promising a ticket
    // that no longer admits anyone is worse than none.
    repo.loadConfirmation.mockResolvedValue(source({ tickets: [] }));
    await handle();
    expect(email.send).not.toHaveBeenCalled();
    expect(idempotency.markCompleted).not.toHaveBeenCalled();
  });
});
