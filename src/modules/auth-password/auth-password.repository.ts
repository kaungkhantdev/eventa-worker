import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { asLocale } from '../../common/messaging/locale';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { organizations, users, type Locale } from '../../db/schema';
import { withTenant } from '../../db/tenant';

/**
 * Read access for the password notices. eventa-api owns these tables; this only
 * reads them, and every query carries its own `organization_id` predicate
 * rather than relying on the RLS policy, which does not apply to the role this
 * service connects as (see `db/tenant.ts`).
 *
 * ON THE DUPLICATE QUERY — THE THIRD IDENTICAL COPY, AND A FLAG RATHER THAN A
 * SHRUG. `accountLocale` below is word for word
 * `AuthTwoFactorRepository.accountLocale` and
 * `AccountDeletionRepository.noticeLocale`. Those two carry a written verdict:
 * keep them apart, because the only other read that resembles them
 * (`UsersRepository.currentAddress`) asks a different question — it needs the
 * ADDRESS too, and a missing row means "nobody to warn" there where these
 * collapse it to {@link DEFAULT_LOCALE}. That verdict said "two honest copies
 * of a nine-line select beat one helper that answers three questions", and it
 * was right about two.
 *
 * This is the third, and three copies is where the arithmetic turns over: the
 * next upstream change to how a language is resolved has to be found in three
 * files instead of one, and the duplication is no longer carrying any
 * distinction — unlike those two, these three really are one question with one
 * answer. The right fix is one shared identity-locale reader under
 * `common/messaging/`, leaving `currentAddress` alone because it genuinely
 * differs. It is NOT done here: this change owns `modules/auth-password/`, and
 * moving two other modules' repositories is a refactor that belongs in its own
 * commit with its own tests rather than riding along inside a new consumer.
 * Recorded here so the next person reads a decision and not an accident.
 */
@Injectable()
export class AuthPasswordRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The account holder's own language, then their workspace's, then English —
   * the identity-mail arm of the precedence `events/reader-locale.ts` applies
   * to attendee mail. There is no event in between, because a password belongs
   * to an account rather than to an event.
   *
   * Looked up by primary key AND organization: the uuid alone would be enough
   * to find the row, but scoping the read to the tenant on the message keeps
   * this query honest about which workspace it is acting for, and the join is
   * what supplies the workspace fallback.
   *
   * Deliberately does not exclude a soft-deleted user, as both sibling notices
   * decided. This read picks only a language, and somebody mid-deletion whose
   * password was just changed by somebody else still needs the notice — in the
   * language they chose, not in English because their row was already flagged.
   *
   * An account this service cannot find at all falls back to English rather
   * than failing: a missing row must not dead-letter a security notice whose
   * recipient address is right there on the message.
   *
   * A lookup that cannot be MADE — the database is down — still rejects from
   * here, because a repository's job is to report what happened, not to decide
   * what it means. The decision belongs to the caller, and
   * `PasswordChangedHandler.localeFor` makes it the same way for EVERY
   * failure: warn, count it, and write the notice in {@link DEFAULT_LOCALE}
   * anyway. So nothing this method rejects with can stop the notice, whatever
   * it is — see `common/db/refinement-read.ts`.
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
