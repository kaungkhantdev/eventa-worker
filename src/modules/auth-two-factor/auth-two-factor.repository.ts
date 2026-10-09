import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { organizations, users, type Locale } from '../../db/schema';
import { asLocale } from '../../common/messaging/locale';
import { withTenant } from '../../db/tenant';

/**
 * Read access for the two-factor notices. eventa-api owns these tables; this
 * only reads them, and every query carries its own `organization_id` predicate
 * rather than relying on the RLS policy, which does not apply to the role this
 * service connects as (see `db/tenant.ts`).
 *
 * ON THE DUPLICATE QUERY, REVIEWED AND KEPT. `accountLocale` below and
 * `AccountDeletionRepository.noticeLocale` are the same statement word for
 * word, and that was weighed against a shared reader under `common/` rather
 * than left to drift. It stays duplicated because the third read that looks
 * like it — `UsersRepository.currentAddress` — is NOT the same question: it
 * needs the account's address as well, and a missing row is a distinct answer
 * there ("nobody to warn") where both of these collapse it to
 * {@link DEFAULT_LOCALE}. A reader shared across all three would have to
 * return the address, which would make these two security reads select and
 * carry a `users.email` they must never log and do not need. Two honest copies
 * of a nine-line select beat one helper that answers three questions.
 *
 * There is no longer a GUARD around the call, and that is the point: the two
 * notice handlers treat a failed language read as unclassifiable by design
 * (`common/db/refinement-read.ts`), because the only thing a classification
 * could decide is whether to withhold a security alert.
 */
@Injectable()
export class AuthTwoFactorRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The account holder's own language, then their workspace's, then English —
   * the identity-mail arm of the precedence `events/reader-locale.ts` applies
   * to attendee mail. There is no event in between, because a security alert is
   * about an account rather than an event.
   *
   * Looked up by primary key AND organization: the uuid alone would be enough
   * to find the row, but scoping the read to the tenant on the message keeps
   * this query honest about which workspace it is acting for, and the join is
   * what supplies the workspace fallback.
   *
   * Deliberately does not exclude a soft-deleted user. This read decides only a
   * language, and somebody mid-deletion whose second factor was just removed
   * still needs the warning — in the language they chose, not in English
   * because their row was already flagged.
   *
   * An account this service cannot find at all falls back to English rather
   * than failing: a missing row must not dead-letter a security alert whose
   * recipient address is right there on the message.
   *
   * A lookup that cannot be MADE — the database is down — still rejects from
   * here, because a repository's job is to report what happened, not to decide
   * what it means. The decision belongs to the caller, and
   * `TwoFactorDisabledHandler.localeFor` makes it the same way for EVERY
   * failure: warn, count it, and alert in {@link DEFAULT_LOCALE} anyway. So
   * nothing this method rejects with can stop the alert, whatever it is — see
   * `common/db/refinement-read.ts`.
   */
  async accountLocale(organizationId: number, userId: string): Promise<Locale> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({ own: users.locale, workspace: organizations.locale })
        .from(users)
        .innerJoin(organizations, eq(organizations.id, users.organizationId))
        .where(
          and(eq(users.id, userId), eq(users.organizationId, organizationId)),
        )
        .limit(1);
      // `asLocale`, not a bare `??`: the column is typed `Locale` but this
      // service only MIRRORS eventa-api's enum, and Drizzle does not map enum
      // values on the way in — so an upstream `ALTER TYPE` reaches the copy
      // table as a key it does not have. See `common/messaging/locale.ts`.
      return asLocale(row?.own ?? row?.workspace);
    });
  }
}
