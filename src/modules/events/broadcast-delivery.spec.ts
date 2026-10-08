import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { SentLedger } from '../../common/idempotency/idempotency.service';
import { deliverToEach } from './broadcast-delivery';
import type { Recipient } from './event-recipients.repository';

const recipient = (email: string): Recipient => ({ email, name: email });

const build = (r: Recipient): EmailMessage => ({
  to: r.email,
  subject: 'Subject',
  text: 'Body',
});

/** In-memory ledger backed by a Set, mirroring IdempotencyService.recipientLedger. */
function fakeLedger(seed: string[] = []): SentLedger {
  const store = new Set<string>(seed);
  return {
    wasSent: (key) => Promise.resolve(store.has(key)),
    markSent: (key) => {
      store.add(key);
      return Promise.resolve();
    },
  };
}

function capturingEmail(failFor: string[] = []): {
  provider: EmailProvider;
  sent: string[];
} {
  const sent: string[] = [];
  const provider: EmailProvider = {
    send: jest.fn((m: EmailMessage) => {
      if (failFor.includes(m.to)) return Promise.reject(new Error('smtp 550'));
      sent.push(m.to);
      return Promise.resolve();
    }),
  };
  return { provider, sent };
}

describe('deliverToEach', () => {
  it('sends one message to every recipient when no ledger is given', async () => {
    const { provider, sent } = capturingEmail();

    const result = await deliverToEach(
      provider,
      [recipient('a@x.test'), recipient('b@x.test')],
      build,
    );

    expect(sent).toEqual(['a@x.test', 'b@x.test']);
    expect(result).toEqual({ sent: 2, failed: 0 });
  });

  it('skips recipients already recorded in the ledger and marks new ones', async () => {
    const { provider, sent } = capturingEmail();
    const ledger = fakeLedger(['a@x.test']); // a was already delivered

    const result = await deliverToEach(
      provider,
      [recipient('a@x.test'), recipient('b@x.test')],
      build,
      ledger,
    );

    expect(sent).toEqual(['b@x.test']); // a not re-sent
    expect(result).toEqual({ sent: 2, failed: 0 }); // a still counts as delivered
    expect(await ledger.wasSent('b@x.test')).toBe(true);
  });

  it('delivers the tail exactly once after an interrupted first pass', async () => {
    const ledger = fakeLedger();
    const recipients = ['a', 'b', 'c', 'd'].map((n) =>
      recipient(`${n}@x.test`),
    );
    const allSends: string[] = [];

    // Pass 1: an interruption leaves c,d undelivered (provider throws on them).
    const first = capturingEmail(['c@x.test', 'd@x.test']);
    const r1 = await deliverToEach(first.provider, recipients, build, ledger);
    allSends.push(...first.sent);
    expect(first.sent).toEqual(['a@x.test', 'b@x.test']);
    expect(r1.failed).toBe(2);

    // Pass 2 (redelivery): same ledger, provider now healthy for everyone.
    const second = capturingEmail();
    const r2 = await deliverToEach(second.provider, recipients, build, ledger);
    allSends.push(...second.sent);

    expect(second.sent).toEqual(['c@x.test', 'd@x.test']); // only the tail
    expect(r2).toEqual({ sent: 4, failed: 0 });

    // Across both passes each recipient was emailed exactly once.
    expect(allSends.sort()).toEqual([
      'a@x.test',
      'b@x.test',
      'c@x.test',
      'd@x.test',
    ]);
  });
});
