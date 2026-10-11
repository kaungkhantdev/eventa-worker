import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { type Locale, organizations, users } from '../../db/schema';
import { asLocale } from '../../common/messaging/locale';
import { withTenant } from '../../db/tenant';

/** The account as it stands today — before any requested change is confirmed. */
export interface AccountAddress {
  /**
   * The address the member signs in with RIGHT NOW. For an email change in
   * flight this is still the OLD address: eventa-api's `requestEmailChange`
   * writes only `pendingEmail`, and `promoteEmail` does not overwrite `email`
   * until the confirmation link is opened.
   */
  email: string;
  /** Their own language choice, falling back to their workspace's. */
  locale: Locale;
}

/**
 * Read access for this module's identity mail. eventa-api owns these tables;
 * nothing here writes.
 *
 * Every query carries its own `organization_id` predicate rather than relying
 * on the RLS policy, which does not apply to the role this service connects as
 * (see `db/tenant.ts`) — `withTenant` is defence in depth, not the boundary.
 *
 * ON NOT SHARING THIS — DECIDED, NOT DEFERRED. The locale half of this read
 * resembles `AuthTwoFactorRepository.accountLocale` and
 * `AccountDeletionRepository.noticeLocale`, and all three were read together
 * and weighed against one shared `common/` lookup for "this account's
 * language". The verdict was to keep them apart, because those two are the same
 * query word for word while this one is a DIFFERENT question: it needs the
 * ADDRESS as well, and a missing row is a distinct answer here — nobody to warn
 * — where the other two collapse it into an English fallback. A reader shared
 * across all three would have to return the address, which would make two
 * security reads that want nothing but a language select and carry a
 * `users.email` they must never log; and this one would lose the null it
 * branches on. Two identical copies are honest; three readers behind one
 * signature would not be.
 *
 * NOR DO THEY SHARE A FAILURE RULE, for the same reason. A failed read of a
 * language leaves a message that is still correct and still addressed, so it
 * must degrade to a default and send; a failed read HERE leaves no address to
 * warn at all, and a warning has no degraded form, so nothing may be delivered
 * past it — the message stays owed and retries. The two rules are opposites
 * drawn from one question (is the lookup essential, or only a refinement?), so
 * there is nothing left for a shared SQLSTATE guard to decide:
 * `EmailChangeHandler.currentAccount` no longer consults
 * `common/db/transient-sql-state.ts`, and does not classify the failure at all.
 */
@Injectable()
export class UsersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The address and language on the account today, or null when this service
   * cannot find the row at all.
   *
   * Null is a distinct answer, not an error: the caller's warning has nowhere
   * to go, while the confirmation link on the message is still perfectly
   * deliverable. Collapsing the two into a default would mail the account
   * holder's warning to a guess.
   *
   * Looked up by primary key AND organization: the uuid alone would find the
   * row, but scoping the read to the tenant on the message keeps this query
   * honest about which workspace it is acting for, and the join is what
   * supplies the workspace's language as a fallback.
   *
   * Deliberately does NOT exclude a soft-deleted user, the same decision the
   * two-factor and closure notices made. This is a security notice: somebody
   * whose account is mid-deletion while a stranger moves it to a new address is
   * precisely the person who still needs to hear about it, and a `deleted_at`
   * predicate would silence the warning exactly when it matters most.
   *
   * A lookup that cannot be MADE still throws from here, exactly as in both
   * sibling repositories: what to do about a database failure belongs to the
   * caller, not to a repository guessing on its behalf. For this read the
   * caller's answer is the same for every failure — the heads-up is owed, so
   * the message must not complete. See `EmailChangeHandler.currentAccount`.
   */
  async currentAddress(
    organizationId: number,
    userId: string,
  ): Promise<AccountAddress | null> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({
          email: users.email,
          own: users.locale,
          workspace: organizations.locale,
        })
        .from(users)
        .innerJoin(organizations, eq(organizations.id, users.organizationId))
        .where(
          and(eq(users.id, userId), eq(users.organizationId, organizationId)),
        )
        .limit(1);
      if (!row) return null;
      // `asLocale`, not a bare `??`: the column is typed `Locale` but this
      // service only MIRRORS eventa-api's enum, and Drizzle does not map enum
      // values on the way in — so an upstream `ALTER TYPE` reaches the copy
      // table as a key it does not have. See `common/messaging/locale.ts`.
      return {
        email: row.email,
        locale: asLocale(row.own ?? row.workspace),
      };
    });
  }
}
