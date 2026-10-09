import { Logger } from '@nestjs/common';
import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { Locale } from '../../db/schema/events';
import type { MetricsService } from '../../metrics/metrics.service';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { AccountDeletionRepository } from './account-deletion.repository';
import { AccountDeletionRequestedHandler } from './account-deletion-requested.handler';

const ctx: MessageContext = {
  routingKey: 'identity.account_deletion_requested',
  messageId: '41',
  correlationId: 'corr-9',
};

/**
 * The payload eventa-api writes, field for field
 * (`account-deletion/events/account-deletion-requested.event.ts`). Note what is
 * NOT here: no grace window, and no cancellation token — the deletion has
 * already happened by the time this message exists.
 */
const rawEvent = {
  version: 1,
  organizationId: 1,
  userId: 'u-77',
  name: 'Somchai',
  email: 'somchai@example.co.th',
  occurredAt: '2026-07-31T17:30:00.000Z',
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
 * notice goes out in all five cases: this is the only message that tells
 * somebody their account is gone and what to do if it was not them, and the
 * alternative to a perfectly-localised one is no notice at all.
 */
const LOOKUP_FAILURES: readonly (readonly [string, unknown])[] = [
  ['a refused connection', pg('ECONNREFUSED')],
  ['a connect timeout carrying no code at all', new Error('timeout expired')],
  ['a query this service got wrong', pg('42703')],
  ['a bug in this service', new TypeError('not a function')],
  ['a thrown string', 'postgres said no'],
];

describe('AccountDeletionRequestedHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let accounts: jest.Mocked<AccountDeletionRepository>;
  let degradedSends: DegradedSend[];
  let metrics: MetricsService;
  let handler: AccountDeletionRequestedHandler;

  const withLocale = (locale: Locale): jest.Mocked<AccountDeletionRepository> =>
    ({
      noticeLocale: jest.fn().mockResolvedValue(locale),
    }) as unknown as jest.Mocked<AccountDeletionRepository>;

  beforeEach(() => {
    sent = [];
    degradedSends = [];
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    accounts = withLocale('en');
    metrics = {
      recordDegradedSend: (routingKey: string, refinement: string) => {
        degradedSends.push({ routingKey, refinement });
      },
    } as unknown as MetricsService;
    handler = new AccountDeletionRequestedHandler(email, accounts, metrics);
  });

  it('subscribes to the account-deletion routing key', () => {
    expect(handler.routingKey).toBe('identity.account_deletion_requested');
  });

  it('tells the account holder, at the address the event carried', async () => {
    await handler.handle(rawEvent, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe('somchai@example.co.th');
    expect(sent[0].subject).toMatch(/deleted/i);
    expect(sent[0].text).toContain('Somchai');
  });

  /**
   * The whole point of this notice. eventa-api stamps `deleted_at` and revokes
   * every session in one transaction before the event is written: there is no
   * grace window to wait out and no token that undoes it. Copy that implied
   * otherwise would be a lie told to the one person who most needs the truth.
   */
  it('says plainly that the closure is already done and cannot be undone', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].text).toMatch(/cannot be undone/i);
    expect(sent[0].text).toMatch(/signed out/i);
  });

  it('offers no link, because no link could reverse it', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].text).not.toMatch(/https?:\/\//);
  });

  /** It matters most when the person did not do it themselves. */
  it('tells a victim what this means — that their password was known', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].text).toMatch(/password/i);
  });

  /** UTC on the wire, Asia/Bangkok on screen: 17:30 UTC is the NEXT day here. */
  it('dates the closure in Bangkok time, not UTC', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].text).toContain('1 August 2026');
    expect(sent[0].text).toContain('00:30');
  });

  it('omits the time rather than printing “Invalid Date”', async () => {
    await handler.handle({ ...rawEvent, occurredAt: 'nonsense' }, ctx);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(sent[0].text).not.toMatch(/invalid date/i);
  });

  it('writes to the account holder in Thai when that is their language', async () => {
    handler = new AccountDeletionRequestedHandler(
      email,
      withLocale('th'),
      metrics,
    );

    await handler.handle(rawEvent, ctx);

    expect(sent[0].subject).toContain('ถูกลบแล้ว');
    expect(sent[0].text).toContain('ไม่สามารถย้อนกลับได้');
  });

  it('asks for the language of the account the event names', async () => {
    await handler.handle(rawEvent, ctx);

    expect(accounts.noticeLocale).toHaveBeenCalledWith(1, 'u-77');
  });

  /**
   * The delivery log is the ORGANIZER's message log (US-MSG-06). A person's own
   * account closure is not the workspace's correspondence, and filing it there
   * would show colleagues that somebody deleted their account — so, like the
   * password reset, this send carries no delivery context.
   */
  it('keeps the closure out of the organizer-visible delivery log', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].delivery).toBeUndefined();
  });

  it('rejects a malformed event', async () => {
    await expect(handler.handle({ userId: 'u-77' }, ctx)).rejects.toBeDefined();
    expect(email.send).not.toHaveBeenCalled();
  });

  /**
   * THE INVARIANT THIS HANDLER EXISTS TO HOLD. No database failure of any kind
   * may cost somebody the only notice that their account is gone. The address
   * and every word of the copy are on the message already; the lookup decides
   * only WHICH language, which is a refinement. So the lookup cannot fail in a
   * way that reaches the send — not a classified outage, not an unclassifiable
   * one, not a bug.
   */
  for (const [shape, cause] of LOOKUP_FAILURES) {
    describe(`when the language lookup fails with ${shape}`, () => {
      beforeEach(() => {
        accounts.noticeLocale.mockRejectedValue(cause);
      });

      it('still sends the closure notice, in English', async () => {
        await handler.handle(rawEvent, ctx);

        expect(email.send).toHaveBeenCalledTimes(1);
        expect(sent[0].to).toBe('somchai@example.co.th');
        expect(sent[0].subject).toMatch(/deleted/i);
        expect(sent[0].text).toMatch(/cannot be undone/i);
        expect(sent[0].text).not.toContain('ไม่สามารถย้อนกลับได้');
      });

      it('counts the degradation, so loudness costs nobody the notice', async () => {
        await handler.handle(rawEvent, ctx);

        expect(degradedSends).toEqual([
          {
            routingKey: 'identity.account_deletion_requested',
            refinement: 'locale',
          },
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
    accounts.noticeLocale.mockRejectedValue(pg('ECONNREFUSED'));

    await handler.handle(rawEvent, ctx);
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();

    expect(logged).toContain('ECONNREFUSED');
    expect(logged).toContain('corr-9');
    expect(logged).not.toContain('somchai@example.co.th');
    expect(logged).not.toContain('Somchai');
  });
});
