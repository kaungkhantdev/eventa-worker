import { Logger } from '@nestjs/common';
import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { Locale } from '../../db/schema/events';
import type { MetricsService } from '../../metrics/metrics.service';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { AuthTwoFactorRepository } from './auth-two-factor.repository';
import { TwoFactorDisabledHandler } from './two-factor-disabled.handler';

const ctx: MessageContext = {
  routingKey: 'identity.two_factor_disabled',
  messageId: '91',
  correlationId: 'corr-2fa',
};

/** Exactly the payload eventa-api's `two-factor-disabled.event.ts` builds. */
const rawEvent = {
  version: 1,
  organizationId: 7,
  userId: '6f0f8a1e-0000-4000-8000-000000000001',
  name: 'Somchai',
  email: 'owner@acme.co.th',
  occurredAt: '2026-10-09T07:05:00.000Z',
};

/** A node-postgres rejection, whose `code` is the SQLSTATE — as `failure.ts` reads it. */
function pg(code: string): Error {
  return Object.assign(new Error('postgres said no'), { code });
}

/** One `recordDegradedSend` call, so a degraded send is provably alertable. */
interface DegradedSend {
  routingKey: string;
  refinement: string;
}

/**
 * Every shape a failed language lookup can arrive in — and the point of the
 * list is that the handler must not tell them apart.
 *
 * A refused connection and a connect timeout are what a real outage looks like
 * (`ECONNREFUSED` carries a 12-character code, a pool timeout carries none at
 * all). A `TypeError`, a class-42 SQLSTATE and a thrown string are bugs. The
 * alert goes out in all five cases, because the alternative to a
 * perfectly-localised warning is not a mis-sent one — it is NO warning about a
 * possible account compromise. Being loud about a bug belongs in the warn line
 * and the counter below, never in withholding the mail.
 */
const LOOKUP_FAILURES: readonly (readonly [string, unknown])[] = [
  ['a refused connection', pg('ECONNREFUSED')],
  ['a connect timeout carrying no code at all', new Error('timeout expired')],
  ['a query this service got wrong', pg('42703')],
  ['a bug in this service', new TypeError('not a function')],
  ['a thrown string', 'postgres said no'],
];

describe('TwoFactorDisabledHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let accounts: jest.Mocked<AuthTwoFactorRepository>;
  let locale: Locale;
  let degradedSends: DegradedSend[];
  let metrics: MetricsService;
  let handler: TwoFactorDisabledHandler;

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
    } as unknown as jest.Mocked<AuthTwoFactorRepository>;
    metrics = {
      recordDegradedSend: (routingKey: string, refinement: string) => {
        degradedSends.push({ routingKey, refinement });
      },
    } as unknown as MetricsService;
    handler = new TwoFactorDisabledHandler(email, accounts, metrics);
  });

  it('subscribes to the two-factor-disabled routing key', () => {
    expect(handler.routingKey).toBe('identity.two_factor_disabled');
  });

  it('alerts the account holder at the address on the event', async () => {
    await handler.handle(rawEvent, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe('owner@acme.co.th');
    expect(sent[0].text).toMatch(/turned off/i);
  });

  /**
   * Identity mail is unconditional. An organizer can switch off the workspace's
   * own attendee templates, but not somebody's security correspondence about
   * their own account — so this handler consults no template catalog at all,
   * and the alert is sent for a workspace that has every template disabled.
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
    expect(sent[0].text).toContain('สองขั้น');
  });

  /**
   * The delivery log is the ORGANIZER's record of mail sent to their attendees.
   * Filing a member's own security alert there would show their personal
   * account mail to colleagues with no business reading it, so this message
   * carries no delivery context and RecordingEmailProvider skips it — the same
   * rule password resets and verification mail follow.
   */
  it('files no row in the workspace delivery log', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].delivery).toBeUndefined();
  });

  it('rejects a malformed event without mailing anybody', async () => {
    await expect(handler.handle({ userId: 'u1' }, ctx)).rejects.toBeDefined();

    expect(email.send).not.toHaveBeenCalled();
  });

  /**
   * A tolerant reader: an added producer field must not dead-letter a real
   * security alert.
   */
  it('ignores unknown fields a newer producer adds', async () => {
    await handler.handle({ ...rawEvent, method: 'totp' }, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
  });

  /**
   * THE INVARIANT THIS HANDLER EXISTS TO HOLD. No database failure of any kind
   * may cost somebody the alert that their second factor was removed. The
   * recipient address and every word of the copy are on the message already;
   * the lookup decides only WHICH language, which is a refinement. So the
   * lookup cannot fail in a way that reaches the send — not a classified
   * outage, not an unclassifiable one, not a bug.
   */
  for (const [shape, cause] of LOOKUP_FAILURES) {
    describe(`when the language lookup fails with ${shape}`, () => {
      beforeEach(() => {
        accounts.accountLocale.mockRejectedValue(cause);
      });

      it('still alerts the account holder, in English', async () => {
        await handler.handle(rawEvent, ctx);

        expect(email.send).toHaveBeenCalledTimes(1);
        expect(sent[0].to).toBe('owner@acme.co.th');
        expect(sent[0].subject).toMatch(/two-factor/i);
        expect(sent[0].text).toMatch(/turned off/i);
        expect(sent[0].text).not.toContain('สองขั้น');
      });

      it('counts the degradation, so loudness costs nobody the alert', async () => {
        await handler.handle(rawEvent, ctx);

        expect(degradedSends).toEqual([
          { routingKey: 'identity.two_factor_disabled', refinement: 'locale' },
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
    expect(logged).toContain('corr-2fa');
    expect(logged).not.toContain('owner@acme.co.th');
    expect(logged).not.toContain('Somchai');
  });
});

describe('TwoFactorDisabledHandler, given a language this mirror has not heard of', () => {
  /*
   * The second form of the same defect. Guarding how the lookup FAILS does
   * nothing about what it RETURNS: eventa-api owns the `locale` pgEnum and this
   * service only mirrors it, and Drizzle's enum column defines no
   * `mapFromDriverValue`, so one `ALTER TYPE locale ADD VALUE` upstream puts a
   * string into a `Locale`-typed variable that is not a `Locale`.
   *
   * The copy table then indexed `undefined` and threw while building the
   * subject — before the send, and as a `TypeError` rather than a failed read,
   * so no warn line and no counter either. The alert rode the retry ladder into
   * the dead-letter queue in silence, for every affected account.
   */
  it('still alerts, in the default language, rather than dead-lettering', async () => {
    const sent: EmailMessage[] = [];
    const email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    } as unknown as EmailProvider;
    const accounts = {
      accountLocale: jest.fn(() => Promise.resolve('ja' as Locale)),
    } as unknown as jest.Mocked<AuthTwoFactorRepository>;
    const metrics = {
      recordDegradedSend: () => undefined,
    } as unknown as MetricsService;

    const handler = new TwoFactorDisabledHandler(email, accounts, metrics);

    await expect(handler.handle(rawEvent, ctx)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('owner@acme.co.th');
    expect(sent[0].text).toMatch(/turned off/i);
  });
});
