import { Logger } from '@nestjs/common';
import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { Locale } from '../../db/schema/events';
import type { MetricsService } from '../../metrics/metrics.service';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { AuthPasswordRepository } from './auth-password.repository';
import { PasswordChangedHandler } from './password-changed.handler';

const ctx: MessageContext = {
  routingKey: 'identity.password_changed',
  messageId: '114',
  correlationId: 'corr-pwd',
};

/** Exactly the payload eventa-api's `password-changed.event.ts` builds. */
const rawEvent = {
  version: 1,
  organizationId: 7,
  userId: '6f0f8a1e-0000-4000-8000-000000000001',
  name: 'Somchai',
  email: 'owner@acme.co.th',
  otherSessionsSignedOut: 4,
  occurredAt: '2026-10-09T07:05:00.000Z',
};

/** A node-postgres rejection, whose `code` is the SQLSTATE — as `failure.ts` reads it. */
function pg(code: string): Error {
  return Object.assign(new Error('postgres said no'), { code });
}

/** The same event with no count on it at all, for the tolerance cases below. */
function withoutCount(): Record<string, unknown> {
  const event: Record<string, unknown> = { ...rawEvent };
  delete event.otherSessionsSignedOut;
  return event;
}

/** One `recordDegradedSend` call, so a degraded send is provably alertable. */
interface DegradedSend {
  routingKey: string;
  refinement: string;
}

/**
 * Every shape a failed language lookup can arrive in — and the point of the
 * list is that the handler must not tell them apart. A refused connection and a
 * pool timeout are what an outage looks like; a `TypeError`, a class-42
 * SQLSTATE and a thrown string are bugs. The notice goes out in all five cases,
 * because the alternative to a perfectly-localised one is not a mis-sent
 * notice — it is NO notice that somebody changed the password on this account.
 */
const LOOKUP_FAILURES: readonly (readonly [string, unknown])[] = [
  ['a refused connection', pg('ECONNREFUSED')],
  ['a connect timeout carrying no code at all', new Error('timeout expired')],
  ['a query this service got wrong', pg('42703')],
  ['a bug in this service', new TypeError('not a function')],
  ['a thrown string', 'postgres said no'],
];

describe('PasswordChangedHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let accounts: jest.Mocked<AuthPasswordRepository>;
  let locale: Locale;
  let degradedSends: DegradedSend[];
  let metrics: MetricsService;
  let handler: PasswordChangedHandler;

  beforeEach(() => {
    sent = [];
    locale = 'en';
    degradedSends = [];
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    accounts = {
      accountLocale: jest.fn(() => Promise.resolve(locale)),
    } as unknown as jest.Mocked<AuthPasswordRepository>;
    metrics = {
      recordDegradedSend: (routingKey: string, refinement: string) => {
        degradedSends.push({ routingKey, refinement });
      },
    } as unknown as MetricsService;
    handler = new PasswordChangedHandler(email, accounts, metrics);
  });

  it('subscribes to the password-changed routing key', () => {
    expect(handler.routingKey).toBe('identity.password_changed');
  });

  it('tells the account holder at the address on the event', async () => {
    await handler.handle(rawEvent, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe('owner@acme.co.th');
    expect(sent[0].subject).toMatch(/password/i);
    expect(sent[0].text).toMatch(/password was changed/i);
  });

  /**
   * Identity mail is unconditional. An organizer can switch off the workspace's
   * own attendee templates, but not somebody's security correspondence about
   * their own account — so this handler consults no template catalog at all,
   * and the notice is sent for a workspace that has every template disabled.
   */
  it('sends without consulting a template catalog', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent).toHaveLength(1);
  });

  it("writes in the account holder's own language", async () => {
    locale = 'th';

    await handler.handle(rawEvent, ctx);

    expect(accounts.accountLocale).toHaveBeenCalledWith(
      7,
      '6f0f8a1e-0000-4000-8000-000000000001',
    );
    expect(sent[0].text).toContain('รหัสผ่าน');
  });

  /**
   * The delivery log is the ORGANIZER's record of mail sent to their attendees
   * (US-MSG-06). Filing a member's own security notice there would show their
   * personal account mail to colleagues with no business reading it, so this
   * message carries no delivery context and RecordingEmailProvider skips it.
   */
  it('files no row in the workspace delivery log', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].delivery).toBeUndefined();
  });

  it('reports how many other devices the change signed out', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].text).toContain('4');
    expect(sent[0].text).toMatch(/signed out/i);
  });

  it('rejects a malformed event without mailing anybody', async () => {
    await expect(handler.handle({ userId: 'u1' }, ctx)).rejects.toBeDefined();

    expect(email.send).not.toHaveBeenCalled();
  });

  /**
   * A tolerant reader: an added producer field must not dead-letter a real
   * security notice.
   */
  it('ignores unknown fields a newer producer adds', async () => {
    await handler.handle({ ...rawEvent, method: 'self-service' }, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
  });

  /**
   * The count buys one sentence; the change, the time and the advice are true
   * without it. So a producer that stops sending it, or sends something that
   * cannot be a count, costs the reader that sentence and NOT the notice —
   * the same rule the language read follows.
   */
  it.each([
    ['absent', {}],
    ['negative', { otherSessionsSignedOut: -1 }],
    ['not a number at all', { otherSessionsSignedOut: 'four' }],
  ])(
    'still sends when the signed-out count is %s',
    async (_shape, override) => {
      await handler.handle({ ...withoutCount(), ...override }, ctx);

      expect(email.send).toHaveBeenCalledTimes(1);
      expect(sent[0].text).toMatch(/password was changed/i);
      expect(sent[0].text).not.toMatch(/signed out/i);
      expect(sent[0].text).not.toMatch(/undefined|nan/i);
    },
  );

  /**
   * THE INVARIANT THIS HANDLER EXISTS TO HOLD. No database failure of any kind
   * may cost somebody the notice that the password on their account was
   * changed. The recipient address and every word of the copy are on the
   * message already; the lookup decides only WHICH language, which is a
   * refinement. So the lookup cannot fail in a way that reaches the send.
   */
  for (const [shape, cause] of LOOKUP_FAILURES) {
    describe(`when the language lookup fails with ${shape}`, () => {
      beforeEach(() => {
        accounts.accountLocale.mockRejectedValue(cause);
      });

      it('still tells the account holder, in English', async () => {
        await handler.handle(rawEvent, ctx);

        expect(email.send).toHaveBeenCalledTimes(1);
        expect(sent[0].to).toBe('owner@acme.co.th');
        expect(sent[0].subject).toMatch(/password/i);
        expect(sent[0].text).toMatch(/password was changed/i);
        expect(sent[0].text).not.toContain('รหัสผ่าน');
      });

      it('counts the degradation, so loudness costs nobody the notice', async () => {
        await handler.handle(rawEvent, ctx);

        expect(degradedSends).toEqual([
          { routingKey: 'identity.password_changed', refinement: 'locale' },
        ]);
      });
    });
  }

  /**
   * The warn line is the whole of "be loud", so it has to carry enough to
   * diagnose the outage and nothing that identifies the person: ids and the
   * error's own code, never the recipient address or the name.
   */
  it('warns with ids and the error code, and no personal data', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    accounts.accountLocale.mockRejectedValue(pg('ECONNREFUSED'));

    await handler.handle(rawEvent, ctx);
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();

    expect(logged).toContain('ECONNREFUSED');
    expect(logged).toContain('corr-pwd');
    expect(logged).not.toContain('owner@acme.co.th');
    expect(logged).not.toContain('Somchai');
  });

  /**
   * And the SUCCESS line too — the path that always runs. A security notice's
   * log line is not the place to copy somebody's address or the name on their
   * profile; the user id identifies the account for support.
   */
  it('logs the send with ids only, never the address or the name', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    await handler.handle(rawEvent, ctx);
    const logged = JSON.stringify(log.mock.calls);
    log.mockRestore();

    expect(logged).toContain('corr-pwd');
    expect(logged).toContain('6f0f8a1e-0000-4000-8000-000000000001');
    expect(logged).not.toContain('owner@acme.co.th');
    expect(logged).not.toContain('Somchai');
  });
});

describe('PasswordChangedHandler, given a language this mirror has not heard of', () => {
  /*
   * The second form of the same defect. Guarding how the lookup FAILS does
   * nothing about what it RETURNS: eventa-api owns the `locale` pgEnum and this
   * service only mirrors it, and Drizzle's enum column defines no
   * `mapFromDriverValue`, so one `ALTER TYPE locale ADD VALUE` upstream puts a
   * string into a `Locale`-typed variable that is not a `Locale`. The copy
   * table then indexed `undefined` and threw while building the subject —
   * before the send, as a `TypeError` rather than a failed read, so with no
   * warn line and no counter either.
   */
  it('still sends, in the default language, rather than dead-lettering', async () => {
    const sent: EmailMessage[] = [];
    const email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    } as unknown as EmailProvider;
    const accounts = {
      accountLocale: jest.fn(() => Promise.resolve('ja' as Locale)),
    } as unknown as jest.Mocked<AuthPasswordRepository>;
    const metrics = {
      recordDegradedSend: () => undefined,
    } as unknown as MetricsService;

    const handler = new PasswordChangedHandler(email, accounts, metrics);

    await expect(handler.handle(rawEvent, ctx)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('owner@acme.co.th');
    expect(sent[0].text).toMatch(/password was changed/i);
  });
});
