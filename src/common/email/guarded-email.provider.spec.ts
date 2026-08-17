import type { EmailMessage, EmailProvider } from './email.provider';
import { GuardedEmailProvider } from './guarded-email.provider';

const message = (to: string): EmailMessage => ({
  to,
  subject: "You're going to Bangkok Tech Week",
  text: 'Your registration is confirmed.',
});

function harness(allowlist: string[], isProduction = false) {
  const send = jest.fn<Promise<void>, [EmailMessage]>(() => Promise.resolve());
  const inner = { send } as unknown as EmailProvider;
  return {
    guarded: new GuardedEmailProvider(inner, allowlist, isProduction),
    send,
  };
}

describe('GuardedEmailProvider', () => {
  it('delivers to an allowed recipient', async () => {
    const { guarded, send } = harness(['me@eventa.test']);

    await guarded.send(message('me@eventa.test'));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('drops a recipient that is not allowed', async () => {
    const { guarded, send } = harness(['me@eventa.test']);

    await guarded.send(message('stranger@example.com'));

    expect(send).not.toHaveBeenCalled();
  });

  /**
   * Dropping is not failing. Throwing would nack the message, retry it, and
   * eventually dead-letter it — filling the DLQ with mail the guard is working
   * exactly as intended by refusing to send.
   */
  it('resolves quietly when it drops, so the message is still acked', async () => {
    const { guarded } = harness([]);

    await expect(
      guarded.send(message('stranger@example.com')),
    ).resolves.toBeUndefined();
  });

  it('passes everything through in production', async () => {
    const { guarded, send } = harness([], true);

    await guarded.send(message('anyone@example.com'));

    expect(send).toHaveBeenCalledTimes(1);
  });

  // The guard decides who, never what: it must not touch the message.
  it('forwards the message unchanged', async () => {
    const { guarded, send } = harness(['@eventa.test']);
    const original = message('me@eventa.test');

    await guarded.send(original);

    expect(send).toHaveBeenCalledWith(original);
  });

  it('lets a real send failure propagate, so the message is retried', async () => {
    const { guarded, send } = harness(['me@eventa.test']);
    send.mockRejectedValueOnce(new Error('SMTP refused'));

    await expect(guarded.send(message('me@eventa.test'))).rejects.toThrow(
      'SMTP refused',
    );
  });
});
