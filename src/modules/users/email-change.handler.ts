import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from '../../common/email/email.provider';
import { DEFAULT_LOCALE } from '../../common/messaging/locale';
import {
  IdempotencyService,
  type SentLedger,
} from '../../common/idempotency/idempotency.service';
import type { Locale } from '../../db/schema/events';
import {
  type MessageContext,
  ValidatedHandler,
} from '../../rabbitmq/message-handler.interface';
import {
  type EmailChangeHeadsUp,
  emailChangeConfirmationBody,
  emailChangeConfirmationSubject,
  emailChangeHeadsUpBody,
  emailChangeHeadsUpSubject,
} from './email-change.notice';
import {
  type EmailChangeRequestedEvent,
  IDENTITY_EMAIL_CHANGE_REQUESTED,
  emailChangeRequestedSchema,
} from './email-change.schema';
import type { AccountAddress } from './users.repository';
import { UsersRepository } from './users.repository';

/**
 * The two messages one email change owes, each recorded in the ledger once it
 * is away. Named constants because they are ledger KEYS: renaming one makes
 * every message in flight owe that part again.
 */
const CONFIRMATION_PART = 'confirmation';
const HEADS_UP_PART = 'heads-up';

/**
 * The language a confirmation is written in when the account cannot be read.
 *
 * Only the CONFIRMATION ever falls back to it. The warning has no language of
 * its own to guess at, because without the row there is no address to send it
 * to either — which is why a failed read is owed rather than defaulted.
 */

/** What one attempt to read the account came back with. */
interface AccountLookup {
  /** The account, or null when there is no row and nothing failed. */
  readonly account: AccountAddress | null;
  /**
   * Set whenever the read THREW, whatever it threw. Boxed so that holding a
   * failure is never confused with having none — a thrown `undefined` is still
   * a failure — and held rather than thrown so the confirmation can go out
   * first; see {@link EmailChangeHandler.process}.
   */
  readonly unreadable?: { readonly cause: unknown };
}

/**
 * Handles `identity.email_change_requested` (US-SET-01): delivers the link that
 * promotes a requested address, and warns the address the account is being
 * moved away from.
 *
 * WHO GETS WHAT, AND WHY — this is the security decision in this handler.
 *
 * The LINK goes to the REQUESTED address and to no other. That is not a
 * convention but the whole mechanism: the link is what proves whoever asked for
 * the change can actually receive mail at the destination, and a confirmation
 * sent anywhere else proves nothing. `confirmUrl` carries a signed token whose
 * claims already name the target address, so opening it completes the change on
 * its own — it is a bearer credential, and the only hands it may be placed in
 * are the ones being asked to prove themselves.
 *
 * In particular the link must NOT be copied to the address currently on the
 * account, tempting as that sounds. Picture the attack this flow exists to
 * resist: somebody with a stolen session asks to move the account to an address
 * they control. Mailing the token to the rightful owner invites the one person
 * who would want to stop the takeover to complete it with a click, and it does
 * so in a message that looks like routine account mail.
 *
 * The OLD address gets a second, deliberately LINK-FREE message. Without it the
 * victim of that same attack is told nothing by anybody —
 * `identity.email_change_requested` is the only event eventa-api emits for this
 * flow, so there is no other notice coming. It says a change was requested, to
 * what, that it has NOT happened yet, and what to do if it was not them; the
 * remedies it names (a new password, signing other sessions out) all happen
 * behind a sign-in the reader starts themselves, because a security alert that
 * trains people to click a link in a security alert is the phishing lure it was
 * meant to warn them about.
 *
 * It also carries no free text the requester wrote — not even the account
 * holder's name, which reaches this handler on the event and is therefore the
 * attacker's to choose in exactly the case this mail reports. Every sentence of
 * it is this service's own, which is what lets the reader weigh it against the
 * other mail they just received. See `email-change.notice.ts`.
 *
 * The old address is read from this service's own `users` view, where it is
 * still the OLD one at this moment: eventa-api's `requestEmailChange` writes
 * only `pendingEmail`, and `promoteEmail` does not overwrite `email` until the
 * link is opened. No producer change is needed, and none is waited for.
 *
 * TWO SENDS, SO A PER-PART LEDGER. Message-level dedupe alone would now be
 * wrong in both directions: `ConsumerService` records completion only after
 * this returns, so a run interrupted between the two sends would re-send the
 * link on redelivery while the warning might never arrive at all.
 * `recipientLedger(messageId)` records each part as it lands, so a redelivery
 * or a DLQ replay delivers only the un-sent tail.
 *
 * That ledger is also what makes RETRYING A FAILED READ safe. The confirmation
 * link has usually already gone out by the time the read is in trouble, and a
 * retry that sent it a second time would be a bug of its own — mailing a
 * bearer credential twice — which is precisely why swallowing the failure and
 * resolving looked like the lesser evil before this record existed. Each part is
 * recorded AFTER its send, so the redelivery owes the heads-up alone and the
 * choice is no longer between a duplicate link and a lost warning. Which
 * failure may retry follows from that:
 *
 * - The LINK failing records nothing, so the error propagates (nack → retry)
 *   and the retry owes both parts. Nobody gets a duplicate.
 * - The WARNING failing after the link is away also propagates, and the retry
 *   sends the warning alone — the member does not get a second link. This is
 *   the half a victim needs, so it is worth retrying for.
 * - A row that is simply MISSING is not a failure at all: there is nobody to
 *   warn, the link still goes, and the read says so by returning null.
 * - A READ THAT FAILED, for any reason at all, propagates too — once the link
 *   is away and recorded. The old address is ESSENTIAL to the warning: there is
 *   no degraded version of "warn the victim", so the only two outcomes on offer
 *   are "still owed" and "abandoned". Resolving would report success to
 *   `ConsumerService`, which then calls `markCompleted`; the id is never
 *   redelivered, and a few-second blip would have delivered the attacker's
 *   confirmation link and withheld the victim's only warning permanently,
 *   behind a single warn line. Propagating leaves the message un-completed, so
 *   the ladder brings it back and the heads-up is still owed.
 *
 * NOT CLASSIFYING THE FAILURE IS THE DECISION, NOT AN OMISSION. A transient
 * SQLSTATE, a refused connection (whose `code` is libuv's, with no SQLSTATE
 * anywhere on it), a connect timeout with no `code` at all, a column eventa-api
 * renamed (class 42) and a plain bug in this service are treated alike, because
 * a classification here could only choose between retrying and completing — and
 * completing destroys the warning whichever of them it was. What the kind of
 * failure does change is how fast the message reaches a human, and that is
 * `rabbitmq/failure.ts`'s job, not this handler's: a class 42 rides the ladder
 * (`isRetryable` defaults to true) and parks in the DLQ some twelve minutes
 * later, which is the right destination, because a replay after the deploy is
 * fixed is the only thing that can still deliver this warning.
 *
 * The sibling locale reads — `TwoFactorDisabledHandler.localeFor`,
 * `AccountDeletionRequestedHandler.localeFor` — look like the same lookup and
 * must do the OPPOSITE. A language only REFINES a message that is already
 * correct and already addressed, so any failure there belongs in a warn log and
 * a metric while the alert still goes, in English. One question decides both: is
 * this lookup essential to the message, or does it only refine it? Essential
 * means never degrade; a refinement means never withhold.
 *
 * Nothing in either direction may reach a log: the token promotes an address,
 * and both addresses and the account holder's name are personal data. Logs are
 * shipped, retained and searched far more widely than an inbox, so the log line
 * carries ids alone.
 *
 * Unconditional, like every other identity notice here (`password-reset`,
 * `email-verification`, `two-factor-disabled`): no template slug, no
 * `templates.isActive` check, and no `delivery` context. An organizer does not
 * get to switch off a member's own security correspondence, and filing it under
 * the workspace message log (US-MSG-06) would show one person's account mail to
 * colleagues who have no business reading it.
 */
@Injectable()
export class EmailChangeHandler extends ValidatedHandler<EmailChangeRequestedEvent> {
  readonly routingKey = IDENTITY_EMAIL_CHANGE_REQUESTED;
  protected readonly schema = emailChangeRequestedSchema;
  private readonly logger = new Logger(EmailChangeHandler.name);

  constructor(
    private readonly email: EmailProvider,
    private readonly accounts: UsersRepository,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  protected async process(
    payload: EmailChangeRequestedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const { account, unreadable } = await this.currentAccount(payload, ctx);
    const done = this.ledgerFor(ctx);
    await once(done, CONFIRMATION_PART, () =>
      this.confirm(payload, account?.locale ?? DEFAULT_LOCALE, ctx),
    );
    // Raised here and not earlier, and for ANY failed read. Not resolving is
    // what keeps the heads-up owed: `ConsumerService` marks this message
    // completed the moment this returns, and a completed message is never
    // redelivered, so resolving would abandon the victim's only warning for
    // good. Raising it only now means the link is already away and recorded, so
    // the member never pays for the read, and the retry owes the warning alone.
    if (unreadable) throw unreadable.cause;
    if (!this.hasAddressToWarn(account, payload)) return;
    await once(done, HEADS_UP_PART, () => this.warn(payload, account, ctx));
  }

  /**
   * The per-part ledger for this message, or none at all when the broker sent
   * no message id — there is then no key to record parts under, and both parts
   * are sent, which is the same trade `ConsumerService` makes for its own
   * message-level dedupe.
   *
   * A failed read still refuses to complete in that case, and the redelivery is
   * still what delivers the warning; the cost is a second confirmation on that
   * redelivery. That is the trade the right way round — a duplicate link is
   * noise, a missing takeover warning is the harm this handler exists to
   * prevent — and `ConsumerService` records no completion without a message id
   * either, so nothing is retired behind our back.
   */
  private ledgerFor(ctx: MessageContext): SentLedger | null {
    return ctx.messageId
      ? this.idempotency.recipientLedger(ctx.messageId)
      : null;
  }

  /** The link, to the requested address alone. */
  private async confirm(
    payload: EmailChangeRequestedEvent,
    locale: Locale,
    ctx: MessageContext,
  ): Promise<void> {
    const notice = {
      name: payload.name,
      locale,
      confirmUrl: payload.confirmUrl,
    };
    await this.email.send({
      to: payload.email,
      subject: emailChangeConfirmationSubject(notice),
      text: emailChangeConfirmationBody(notice),
    });
    // Ids only. `confirmUrl` is a bearer credential and the recipient is PII.
    this.logger.log(
      { correlationId: ctx.correlationId, userId: payload.userId, locale },
      'Sent email-change confirmation to the requested address',
    );
  }

  /** The heads-up, to the address the account is being moved away from. */
  private async warn(
    payload: EmailChangeRequestedEvent,
    account: AccountAddress,
    ctx: MessageContext,
  ): Promise<void> {
    // No name: the one string on this event the requester wrote stays out of
    // the mail that warns about them. See `email-change.notice.ts`.
    const notice: EmailChangeHeadsUp = {
      locale: account.locale,
      requestedEmail: payload.email,
      occurredAt: new Date(payload.occurredAt),
    };
    await this.email.send({
      to: account.email,
      subject: emailChangeHeadsUpSubject(notice),
      text: emailChangeHeadsUpBody(notice),
    });
    this.logger.log(
      {
        correlationId: ctx.correlationId,
        userId: payload.userId,
        locale: account.locale,
      },
      'Warned the current address that an email change was requested',
    );
  }

  /**
   * One attempt to read the account: the row, no row, or a failure the caller
   * must not deliver past.
   *
   * There is no third category and no classification of the failure — see the
   * class docstring. A missing row is an answer (nobody to warn); anything that
   * THREW leaves the heads-up owed, so the cause is carried back for
   * {@link EmailChangeHandler.process} to raise once the link is recorded.
   * Returned rather than thrown from here, because throwing would withhold the
   * link too, and the link is deliverable whatever the warning's side does.
   *
   * The warn line carries ids and a short code only. The read binds nothing but
   * ids, yet a driver error quotes the host it could not reach and can quote
   * what was bound, while both addresses and the account holder's name are PII
   * with no business in a log. It is a warn rather than an error because
   * `ConsumerService` logs the throw itself a moment later; this line exists to
   * say WHICH read failed, which that one cannot.
   */
  private async currentAccount(
    payload: EmailChangeRequestedEvent,
    ctx: MessageContext,
  ): Promise<AccountLookup> {
    try {
      const account = await this.accounts.currentAddress(
        payload.organizationId,
        payload.userId,
      );
      return { account };
    } catch (cause) {
      this.logger.warn(
        {
          correlationId: ctx.correlationId,
          userId: payload.userId,
          errorCode: errorCodeOf(cause),
        },
        'Could not read the address to warn — the heads-up is still owed, so the message will not complete',
      );
      return { account: null, unreadable: { cause } };
    }
  }

  /**
   * Is there a DIFFERENT mailbox to warn?
   *
   * eventa-api rejects a no-op change, but its check is a case-sensitive JS
   * comparison against a `citext` column, so a change of case alone passes it
   * and arrives here. Comparing case-insensitively is what stops one person
   * being sent two mails about one change — and it is this service's own
   * guard either way, because an assumption about another service's validation
   * is not a reason to mail somebody twice.
   */
  private hasAddressToWarn(
    account: AccountAddress | null,
    payload: EmailChangeRequestedEvent,
  ): account is AccountAddress {
    return account !== null && !isSameMailbox(account.email, payload.email);
  }
}

/**
 * Run `work` unless the ledger already records this part as done, then record
 * it. Recorded AFTER the send, so an interrupted run re-sends nothing that
 * landed and still owes everything that did not.
 *
 * The same three lines sit, unexported, in `registration-confirmed.handler.ts`,
 * which is the other multi-part send here. Two copies is the point at which a
 * shared `common/idempotency` helper starts to earn its place; reaching into
 * another module for one would not, so this is a local copy and a note rather
 * than a cross-module import.
 */
async function once(
  done: SentLedger | null,
  part: string,
  work: () => Promise<void>,
): Promise<void> {
  if (done && (await done.wasSent(part))) return;
  await work();
  await done?.markSent(part);
}

function isSameMailbox(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * A short, safe label for a failed read: node-postgres's `code` — a SQLSTATE
 * like `42703`, or libuv's `ECONNREFUSED` when the connection never opened —
 * and the error's type when it carries no code at all, which a connect timeout
 * and a bug in this service both do.
 *
 * Deliberately not the message: a driver error quotes the host and port it
 * could not reach, and may quote what the query bound. The label is here to be
 * greppable, not to classify anything — nothing in this handler branches on it.
 */
function errorCodeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const { code } = cause as { code?: unknown };
    if (typeof code === 'string' && code.length > 0) return code;
    if (cause instanceof Error) return cause.name;
  }
  return typeof cause;
}
