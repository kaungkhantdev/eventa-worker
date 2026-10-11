import { Logger } from '@nestjs/common';
import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type {
  IdempotencyService,
  SentLedger,
} from '../../common/idempotency/idempotency.service';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { EmailChangeHandler } from './email-change.handler';
import type { AccountAddress, UsersRepository } from './users.repository';

const ctx: MessageContext = {
  routingKey: 'identity.email_change_requested',
  messageId: '11',
  correlationId: 'corr-3',
};

const CONFIRM_URL = 'https://web.test/confirm-email?token=CTOKEN';
const OLD_ADDRESS = 'old-address@acme.co.th';
const REQUESTED = 'new-address@acme.co.th';

const rawEvent = {
  version: 1,
  organizationId: 7,
  userId: 'u1',
  name: 'Somchai',
  email: REQUESTED,
  confirmUrl: CONFIRM_URL,
  occurredAt: '2026-10-09T07:05:00.000Z',
};

/** A node-postgres rejection, whose `code` is the SQLSTATE — as `failure.ts` reads it. */
function pg(code: string): Error {
  return Object.assign(new Error('postgres said no'), { code });
}

/**
 * What the commonest outage actually looks like. node-postgres hands the socket
 * error straight through, so `code` is libuv's `ECONNREFUSED` and there is no
 * SQLSTATE anywhere on it. The message quotes the host:port, which is why the
 * log assertions below check the error itself never reaches a log line.
 */
function connectionRefused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
    code: 'ECONNREFUSED',
  });
}

/** A pool/connect timeout: an Error carrying no `code` whatsoever. */
function connectTimeout(): Error {
  return new Error('timeout exceeded when trying to connect');
}

/** Idempotency stub backing recipientLedger() with a shared in-memory Set. */
function stubIdempotency(seed: string[] = []): {
  idempotency: IdempotencyService;
  ledgerStore: Set<string>;
} {
  const ledgerStore = new Set<string>(seed);
  const ledger: SentLedger = {
    wasSent: (key) => Promise.resolve(ledgerStore.has(key)),
    markSent: (key) => {
      ledgerStore.add(key);
      return Promise.resolve();
    },
  };
  const idempotency = {
    recipientLedger: jest.fn(() => ledger),
  } as unknown as IdempotencyService;
  return { idempotency, ledgerStore };
}

describe('EmailChangeHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let accounts: jest.Mocked<UsersRepository>;
  let account: AccountAddress | null;
  let idempotency: IdempotencyService;
  let ledgerStore: Set<string>;
  let handler: EmailChangeHandler;

  beforeEach(() => {
    sent = [];
    account = { email: OLD_ADDRESS, locale: 'en' };
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    accounts = {
      currentAddress: jest.fn(() => Promise.resolve(account)),
    } as unknown as jest.Mocked<UsersRepository>;
    ({ idempotency, ledgerStore } = stubIdempotency());
    handler = new EmailChangeHandler(email, accounts, idempotency);
  });

  it('subscribes to the email-change routing key', () => {
    expect(handler.routingKey).toBe('identity.email_change_requested');
  });

  /**
   * The confirmation proves control of the DESTINATION, so the link may only
   * ever go to the requested address — the API says as much on the payload
   * field itself.
   */
  it('sends the confirmation link to the requested address, and only there', async () => {
    await handler.handle(rawEvent, ctx);

    const withLink = sent.filter((m) => m.text.includes(CONFIRM_URL));
    expect(withLink).toHaveLength(1);
    expect(withLink[0].to).toBe(REQUESTED);
    expect(withLink[0].subject).toMatch(/confirm/i);
    expect(withLink[0].text).toContain('Somchai');
  });

  /**
   * Nothing is lost until the link is opened, and a recipient who is about to
   * be told "confirm this" deserves to know that their old address still signs
   * them in — otherwise an unopened link reads as a locked-out account.
   */
  it('says the link is single-use, time-limited, and that the current address still works', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].text).toMatch(/24 hours/);
    expect(sent[0].text).toMatch(/once/i);
    expect(sent[0].text).toMatch(/current email/i);
  });

  /**
   * The requested address may belong to a stranger who was typed in by mistake.
   * They are told to ignore it, not to go and secure an account they do not
   * have — the "somebody is taking over your account" warning belongs on the
   * OLD address.
   */
  it('tells a recipient who did not ask for this that they can ignore it', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].text).toMatch(/ignore/i);
  });

  /**
   * The gap this handler exists to close: an attacker holding a stolen session
   * moves the account to an address they control, and
   * `identity.email_change_requested` is the ONLY event the API emits for the
   * flow. Without this send the rightful owner is told nothing by anybody.
   */
  it('warns the address currently on the account as well as the requested one', async () => {
    await handler.handle(rawEvent, ctx);

    expect(email.send).toHaveBeenCalledTimes(2);
    expect(accounts.currentAddress).toHaveBeenCalledWith(7, 'u1');
    expect(sent.map((m) => m.to)).toEqual([REQUESTED, OLD_ADDRESS]);
  });

  /**
   * THE security property. `confirmUrl` is a bearer credential whose claims
   * already name the target, so copying it to the old address would hand a
   * victim the button that completes their own takeover — and any link at all
   * in a security alert trains the reader for the phishing mail that imitates
   * it.
   */
  it('puts no token and no link of any kind in the warning', async () => {
    await handler.handle(rawEvent, ctx);

    const warning = sent[1];
    expect(warning.to).toBe(OLD_ADDRESS);
    expect(warning.text).not.toContain(CONFIRM_URL);
    expect(warning.text).not.toContain('CTOKEN');
    expect(warning.text).not.toMatch(/https?:/i);
    expect(warning.text).not.toContain('://');
  });

  it('tells the old address where the account is being moved to', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[1].text).toContain(REQUESTED);
    expect(sent[1].text).toMatch(/not yet/i);
  });

  /**
   * eventa-api rejects a no-op change, but its check is a case-SENSITIVE JS
   * comparison against a citext column, so a case-only change reaches this
   * consumer. Two mails to one mailbox about one change is a bug the reader
   * experiences as noise in a security alert.
   */
  it('sends only the confirmation when the account already uses that mailbox', async () => {
    account = { email: 'New-Address@ACME.co.th', locale: 'en' };

    await handler.handle(rawEvent, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe(REQUESTED);
  });

  /**
   * THE PROPERTY A FAILED READ MUST HAVE, whatever failed.
   *
   * The old address is ESSENTIAL: there is no degraded version of "warn the
   * victim", so the only two outcomes are "still owed" and "abandoned". `process`
   * must therefore REJECT, because `ConsumerService` calls `markCompleted` only
   * after it resolves — resolving retires the message id, nothing is ever
   * redelivered, and the warning is never owed again.
   *
   * The link goes first and is recorded first, so being loud never costs the
   * member the part they are waiting for, and the retry owes the heads-up alone.
   */
  const expectWarningStillOwed = async (): Promise<void> => {
    await expect(handler.handle(rawEvent, ctx)).rejects.toBeDefined();

    expect(sent.map((m) => m.to)).toEqual([REQUESTED]);
    expect(sent[0].text).toContain(CONFIRM_URL);
    expect([...ledgerStore]).toEqual(['confirmation']);
  };

  /**
   * THE DEFECT. A few-second blip used to resolve: the attacker's confirmation
   * link was delivered, the victim's only warning was dropped behind one warn
   * line, and `markCompleted` made that permanent. A refused connection is the
   * commonest shape of that blip.
   */
  it('keeps the warning owed when the connection was refused', async () => {
    accounts.currentAddress.mockRejectedValue(connectionRefused());

    await expectWarningStillOwed();
  });

  /**
   * And the live defect in its purest form. A connection that dropped mid-read
   * reports SQLSTATE 08006, the one shape the old guard DID recognise — so it
   * was swallowed, `process` resolved, `markCompleted` retired the message id,
   * and the warning was owed to nobody ever again.
   */
  it('keeps the warning owed when the connection dropped mid-read', async () => {
    accounts.currentAddress.mockRejectedValue(pg('08006'));

    await expectWarningStillOwed();
  });

  /** Same for a deadlock: a database that blinked is not permission to drop it. */
  it('keeps the warning owed when the read deadlocked', async () => {
    accounts.currentAddress.mockRejectedValue(pg('40001'));

    await expectWarningStillOwed();
  });

  /** A connect/pool timeout carries no code at all, and is no less transient. */
  it('keeps the warning owed when the read times out with no code', async () => {
    accounts.currentAddress.mockRejectedValue(connectTimeout());

    await expectWarningStillOwed();
  });

  /** Nor may a bug in this service decide the victim hears nothing. */
  it('keeps the warning owed when the read throws a plain TypeError', async () => {
    accounts.currentAddress.mockRejectedValue(
      new TypeError('cannot read properties of undefined'),
    );

    await expectWarningStillOwed();
  });

  /**
   * And the same for a read that can never succeed — a column eventa-api
   * renamed, SQLSTATE class 42. Retrying cannot fix it, but completing would
   * destroy the warning, while parking it in the DLQ keeps it replayable once
   * the deploy is fixed. Classifying the failure would change how FAST it
   * reaches a human, never whether the heads-up survives, so this handler no
   * longer classifies at all.
   */
  it('keeps the warning owed when the schema moved under it', async () => {
    accounts.currentAddress.mockRejectedValue(pg('42703'));

    await expectWarningStillOwed();
  });

  /** The cause is rethrown as-is, so `failure.ts` can still rate the retry. */
  it('rethrows the cause the read failed with, untouched', async () => {
    accounts.currentAddress.mockRejectedValue(connectionRefused());

    await expect(handler.handle(rawEvent, ctx)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  /**
   * THE TENSION THIS RESOLVES. The confirmation link is already away, so a
   * retry must not send it twice — and that is exactly what the ledger is for:
   * `recipientLedger(messageId)` recorded the 'confirmation' part AFTER it
   * landed, so the redelivery owes the 'heads-up' part alone. Rejecting is safe
   * here only because of that; without the ledger it would be a duplicate-link
   * bug, which is why the previous pass resolved instead.
   */
  it('delivers exactly the missing warning on the retry, never a second link', async () => {
    accounts.currentAddress.mockRejectedValueOnce(connectionRefused());

    await expect(handler.handle(rawEvent, ctx)).rejects.toBeDefined();
    expect([...ledgerStore]).toEqual(['confirmation']);

    await handler.handle(rawEvent, ctx);

    expect(sent.filter((m) => m.to === REQUESTED)).toHaveLength(1);
    expect(sent.filter((m) => m.to === OLD_ADDRESS)).toHaveLength(1);
    expect([...ledgerStore].sort()).toEqual(['confirmation', 'heads-up']);
  });

  /**
   * With no message id there is no ledger — and no completion marker either, so
   * the redelivery is still what delivers the warning. The cost is a second
   * link on that redelivery: the same trade `ConsumerService` already makes for
   * its own message-level dedupe, and the right way round, because a duplicate
   * link is noise while a missing takeover warning is the harm this handler
   * exists to prevent.
   */
  it('still refuses to complete when there is no message id to key a ledger', async () => {
    accounts.currentAddress.mockRejectedValue(connectionRefused());

    await expect(
      handler.handle(rawEvent, { ...ctx, messageId: undefined }),
    ).rejects.toBeDefined();

    expect(sent.map((m) => m.to)).toEqual([REQUESTED]);
  });

  /**
   * The retry has to be diagnosable from the log without the error in it: a
   * driver error quotes the host it could not reach and can quote what was
   * bound, while both addresses and the name are the account holder's PII.
   */
  it('logs the error code and ids, never the error itself or the people', async () => {
    accounts.currentAddress.mockRejectedValue(connectionRefused());
    const warned = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(handler.handle(rawEvent, ctx)).rejects.toBeDefined();

    const text = JSON.stringify(warned.mock.calls);
    expect(text).toContain('ECONNREFUSED');
    expect(text).toContain('u1');
    expect(text).toContain('corr-3');
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain(OLD_ADDRESS);
    expect(text).not.toContain(REQUESTED);
    expect(text).not.toContain('Somchai');
    warned.mockRestore();
  });

  /** An error with no code still gets a label an operator can grep for. */
  it('logs the error type when the failure carries no code', async () => {
    accounts.currentAddress.mockRejectedValue(connectTimeout());
    const warned = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(handler.handle(rawEvent, ctx)).rejects.toBeDefined();

    const text = JSON.stringify(warned.mock.calls);
    expect(text).toContain('Error');
    expect(text).not.toContain('timeout exceeded');
    warned.mockRestore();
  });

  /** A member whose row has gone still gets the link; there is nobody to warn. */
  it('still sends the confirmation when the account row is missing', async () => {
    account = null;

    await expect(handler.handle(rawEvent, ctx)).resolves.toBeUndefined();

    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it("writes both messages in the account holder's own language", async () => {
    account = { email: OLD_ADDRESS, locale: 'th' };

    await handler.handle(rawEvent, ctx);

    expect(sent[0].text).toContain('24 ชั่วโมง');
    expect(sent[1].text).toContain('รหัสผ่าน');
  });

  /**
   * Account mail is not the organizer's message log (US-MSG-06): filing a
   * member's own email change under the workspace would show their personal
   * correspondence to colleagues who have no business reading it.
   */
  it('attaches no delivery context to either part', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent.map((m) => m.delivery)).toEqual([undefined, undefined]);
  });

  /**
   * Two sends mean message-level dedupe is no longer enough: it would re-send
   * the link on every redelivery while the warning might never arrive. The
   * per-part ledger is what makes a redelivery deliver the un-sent tail only.
   */
  it('skips a part an earlier run already delivered', async () => {
    ({ idempotency, ledgerStore } = stubIdempotency(['confirmation']));
    handler = new EmailChangeHandler(email, accounts, idempotency);

    await handler.handle(rawEvent, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe(OLD_ADDRESS);
  });

  it('records each part as it lands', async () => {
    await handler.handle(rawEvent, ctx);

    expect([...ledgerStore].sort()).toEqual(['confirmation', 'heads-up']);
  });

  /**
   * A warning that failed to send MAY retry: it is the half the victim needs
   * and nothing has been lost. Because the link is already recorded, the retry
   * sends the warning alone — the member does not get a second link.
   */
  it('lets a failed warning retry without re-sending the link', async () => {
    (email.send as jest.Mock).mockImplementationOnce((m: EmailMessage) => {
      sent.push(m);
      return Promise.resolve();
    });
    (email.send as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error('smtp down')),
    );

    await expect(handler.handle(rawEvent, ctx)).rejects.toThrow('smtp down');
    expect([...ledgerStore]).toEqual(['confirmation']);

    await handler.handle(rawEvent, ctx);

    expect(sent.filter((m) => m.to === REQUESTED)).toHaveLength(1);
    expect(sent.filter((m) => m.to === OLD_ADDRESS)).toHaveLength(1);
  });

  /** Nothing recorded, so a retry owes both parts — and sends each one once. */
  it('owes both parts again when the link itself failed', async () => {
    (email.send as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error('smtp down')),
    );

    await expect(handler.handle(rawEvent, ctx)).rejects.toThrow('smtp down');
    expect([...ledgerStore]).toEqual([]);

    await handler.handle(rawEvent, ctx);

    expect(sent.map((m) => m.to)).toEqual([REQUESTED, OLD_ADDRESS]);
  });

  /**
   * `confirmUrl` carries a signed token that promotes the new address on its
   * own — a bearer credential. Logs are shipped, searched and retained far more
   * widely than inboxes, so it must never reach one.
   */
  it('never writes the confirmation token to a log line', async () => {
    const logged = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    await handler.handle(rawEvent, ctx);

    expect(logged).toHaveBeenCalled();
    const text = JSON.stringify(logged.mock.calls);
    expect(text).not.toContain('CTOKEN');
    expect(text).not.toContain(CONFIRM_URL);
    logged.mockRestore();
  });

  /**
   * Both addresses are PII, and so is the account holder's name; none of them
   * belongs in a log line that an operator reads to follow a message through.
   */
  it('keeps both recipients out of the log line, carrying only ids', async () => {
    const logged = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    await handler.handle(rawEvent, ctx);

    const text = JSON.stringify(logged.mock.calls);
    expect(text).not.toContain(REQUESTED);
    expect(text).not.toContain(OLD_ADDRESS);
    expect(text).not.toContain('Somchai');
    expect(text).toContain('u1');
    logged.mockRestore();
  });

  /**
   * The name on the event is free text written by the stolen session this flow
   * resists: eventa-api's `UpdateProfileDto` is `@IsString() @MaxLength(200)`
   * with no charset or newline restriction. A newline plus a URL would put an
   * attacker-chosen destination above the warning in a plain-text mail that
   * most clients linkify — in the one mail whose body promises it has no links.
   */
  it('lets a name an attacker chose inject a line into neither mail', async () => {
    const name =
      'Somchai\n\nURGENT: secure your account now at https://eventa-help.evil.test/fix';

    await handler.handle({ ...rawEvent, name }, ctx);

    for (const message of sent) {
      expect(message.subject).not.toMatch(/[\r\n]/);
      expect(message.text).not.toMatch(/^URGENT/m);
      expect(message.text).not.toContain('evil.test');
    }
    // The warning takes no name at all, so nothing the attacker wrote is in it.
    expect(sent[1].to).toBe(OLD_ADDRESS);
    expect(sent[1].text).not.toContain('Somchai');
    expect(sent[1].text).not.toContain('URGENT');
    expect(sent[1].text).not.toMatch(/https?:/i);
  });

  it('rejects a malformed event (tolerant reader still requires the core fields)', async () => {
    await expect(handler.handle({ userId: 'u1' }, ctx)).rejects.toBeDefined();
    expect(email.send).not.toHaveBeenCalled();
  });

  /** A field a newer producer adds must not dead-letter a real change. */
  it('ignores unknown fields a newer producer adds', async () => {
    await handler.handle({ ...rawEvent, previousEmail: OLD_ADDRESS }, ctx);

    expect(email.send).toHaveBeenCalledTimes(2);
  });
});
