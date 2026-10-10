import { Logger } from '@nestjs/common';
import type { MessageDeliveriesRepository } from '../messaging/message-deliveries.repository';
import { RecordingSmsProvider } from './recording-sms.provider';
import type { SmsMessage, SmsProvider } from './sms.provider';

const NOW = new Date('2026-07-31T09:00:00.000Z');
const NUMBER = '+66812345678';

const message = (over: Partial<SmsMessage> = {}): SmsMessage => ({
  to: NUMBER,
  text: 'Eventa: you are registered. Ref ORD-7K2M9QX4',
  delivery: {
    organizationId: 7,
    kind: 'registration-confirmation',
    recipientName: 'Anong',
    recipientEmail: 'anong@x.test',
    eventId: 'e1',
  },
  ...over,
});

describe('RecordingSmsProvider (US-MSG-06)', () => {
  let inner: jest.Mocked<SmsProvider>;
  let deliveries: jest.Mocked<MessageDeliveriesRepository>;
  let provider: RecordingSmsProvider;

  beforeEach(() => {
    inner = {
      enabled: true,
      send: jest.fn().mockResolvedValue(undefined),
    };
    deliveries = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<MessageDeliveriesRepository>;
    provider = new RecordingSmsProvider(inner, deliveries, { now: () => NOW });
  });

  it('still sends through the transport it wraps', async () => {
    const m = message();
    await provider.send(m);
    expect(inner.send).toHaveBeenCalledWith(m);
  });

  it('follows the transport on whether SMS is available at all', () => {
    expect(provider.enabled).toBe(true);
    const off = new RecordingSmsProvider(
      { enabled: false, send: jest.fn() },
      deliveries,
      { now: () => NOW },
    );
    expect(off.enabled).toBe(false);
  });

  it('records the text on the sms channel, under the person’s address', async () => {
    await provider.send(message());

    expect(deliveries.record).toHaveBeenCalledWith({
      organizationId: 7,
      channel: 'sms',
      kind: 'registration-confirmation',
      recipientEmail: 'anong@x.test',
      recipientName: 'Anong',
      eventId: 'e1',
      status: 'sent',
      error: null,
      sentAt: NOW,
    });
  });

  it('never writes the phone number into the log', async () => {
    // There is no phone column, and the number must not end up smuggled into
    // one of the text ones instead.
    await provider.send(message());
    expect(JSON.stringify(deliveries.record.mock.calls)).not.toContain(
      '812345678',
    );
  });

  it('records the failure AND rethrows, so the caller still retries', async () => {
    inner.send.mockRejectedValue(new Error('SMS provider refused (HTTP 400)'));

    await expect(provider.send(message())).rejects.toThrow('HTTP 400');
    expect(deliveries.record).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'sms',
        status: 'failed',
        error: 'SMS provider refused (HTTP 400)',
      }),
    );
  });

  it('records nothing for a text that carries no context', async () => {
    await provider.send(message({ delivery: undefined }));

    expect(inner.send).toHaveBeenCalled();
    expect(deliveries.record).not.toHaveBeenCalled();
  });

  it('does not fail a SENT text because the log write failed', async () => {
    // The text has gone. Throwing would dead-letter it and text somebody twice
    // — and a text, unlike an email, costs money each time.
    deliveries.record.mockRejectedValue(new Error('db down'));

    await expect(provider.send(message())).resolves.toBeUndefined();
  });

  it('still rethrows the SEND error when the log write also fails', async () => {
    inner.send.mockRejectedValue(new Error('HTTP 503'));
    deliveries.record.mockRejectedValue(new Error('db down'));

    await expect(provider.send(message())).rejects.toThrow('HTTP 503');
  });

  /**
   * The warn line when the delivery log cannot be written — the SMS twin.
   *
   * Identical to the email recorder's, and that is the point: the same
   * `reasonOf(cause)` returned the caught error's `.message`, and the cause here
   * comes from Drizzle, which builds it as
   * (drizzle-orm@0.45.2/errors.cjs:36)
   *
   *     super(`Failed query: ${query}\nparams: ${params}`)
   *
   * so the message carries the BOUND PARAMS of this very insert — the
   * recipient's email address and their name. Fixing the email recorder alone
   * left this one leaking the same values from a copy of the same four lines,
   * which is why `dbReason` is now shared rather than written twice.
   */
  describe('when the delivery log cannot be written', () => {
    const RECIPIENT = 'anong@x.test';
    const RECIPIENT_NAME = 'Anong';

    function drizzleFailure(): Error {
      const params = [
        7,
        'sms',
        'registration-confirmation',
        RECIPIENT,
        RECIPIENT_NAME,
      ];
      const err = new Error(
        'Failed query: insert into "message_deliveries" ' +
          '("organization_id","channel","kind","recipient_email","recipient_name") ' +
          'values ($1,$2,$3,$4,$5)\nparams: ' +
          params.join(','),
      );
      err.cause = Object.assign(new Error('deadlock detected'), {
        code: '40P01',
      });
      return err;
    }

    function captureWarnings(): { text: () => string; restore: () => void } {
      const seen: unknown[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((...args: unknown[]) => {
          seen.push(...args);
        });
      return {
        text: () => JSON.stringify(seen),
        restore: () => spy.mockRestore(),
      };
    }

    it('does not print the recipient into the log', async () => {
      deliveries.record.mockRejectedValue(drizzleFailure());
      const captured = captureWarnings();
      try {
        await provider.send(message());

        expect(captured.text()).not.toContain(RECIPIENT);
        expect(captured.text()).not.toContain(RECIPIENT_NAME);
      } finally {
        captured.restore();
      }
    });

    it('does not print the statement either', async () => {
      deliveries.record.mockRejectedValue(drizzleFailure());
      const captured = captureWarnings();
      try {
        await provider.send(message());

        expect(captured.text()).not.toContain('insert into');
        expect(captured.text()).not.toContain('params:');
      } finally {
        captured.restore();
      }
    });

    it('says what the database refused, by code', async () => {
      deliveries.record.mockRejectedValue(drizzleFailure());
      const captured = captureWarnings();
      try {
        await provider.send(message());

        expect(captured.text()).toContain('40P01');
      } finally {
        captured.restore();
      }
    });
  });
});
