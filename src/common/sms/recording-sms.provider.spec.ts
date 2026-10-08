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
});
