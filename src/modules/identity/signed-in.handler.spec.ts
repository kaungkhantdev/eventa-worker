import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { AuditRepository } from './audit.repository';
import { SignedInHandler } from './signed-in.handler';

const ctx: MessageContext = {
  routingKey: 'identity.signed_in',
  messageId: 'm1',
  correlationId: 'c1',
};

describe('SignedInHandler', () => {
  let audit: jest.Mocked<AuditRepository>;
  let handler: SignedInHandler;

  beforeEach(() => {
    audit = {
      recordSignIn: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditRepository>;
    handler = new SignedInHandler(audit);
  });

  it('validates the payload and records the sign-in audit', async () => {
    await handler.handle(
      {
        version: 1,
        organizationId: 7,
        userId: 'u1',
        device: 'Chrome',
        ip: '1.2.3.4',
        occurredAt: '2026-07-28T10:00:00.000Z',
      },
      ctx,
    );
    expect(audit.recordSignIn).toHaveBeenCalledWith({
      organizationId: 7,
      userId: 'u1',
      device: 'Chrome',
      ip: '1.2.3.4',
      occurredAt: new Date('2026-07-28T10:00:00.000Z'),
    });
  });

  it('is a tolerant reader — strips unknown fields, defaults missing ip to null', async () => {
    await handler.handle(
      {
        organizationId: 7,
        userId: 'u1',
        device: 'Chrome',
        occurredAt: '2026-07-28T10:00:00.000Z',
        surprise: 'ignored',
      },
      ctx,
    );
    expect(audit.recordSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ ip: null }),
    );
  });

  it('rejects an invalid payload and does not write', async () => {
    await expect(
      handler.handle(
        { organizationId: 'nope', userId: 'u1', device: 'x', occurredAt: 'x' },
        ctx,
      ),
    ).rejects.toThrow();
    expect(audit.recordSignIn).not.toHaveBeenCalled();
  });
});
