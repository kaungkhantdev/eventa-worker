import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { type Locale, organizations, users } from '../../db/schema';
import { asLocale } from '../../common/messaging/locale';
import { withTenant } from '../../db/tenant';

/**
 * When neither the person nor their workspace names a language — and when the
 * lookup cannot be made at all, which is why the caller needs it too.
 */

/**
 * The one read the closure notice needs: which language to write it in.
 * eventa-api owns the schema; nothing here writes.
 *
 * ON THE DUPLICATE QUERY, REVIEWED AND KEPT. `noticeLocale` below and
 * `AuthTwoFactorRepository.accountLocale` are the same statement word for word;
 * the reasons for keeping both rather than extracting a shared reader are
 * written out in that file's docstring, and the deciding one is that the third
 * read that resembles them, `UsersRepository.currentAddress`, answers a
 * different question. Note that the `deleted_at` reasoning below and the
 * two-factor one reach the same SQL from opposite directions — there the
 * recipient may be mid-deletion, here they always are — which is the other
 * reason one shared docstring could not speak for both.
 *
 * There is no longer a GUARD around the call, and that is the point: the
 * closure-notice handler treats a failed language read as unclassifiable by
 * design (`common/db/refinement-read.ts`), because the only thing a
 * classification could decide is whether to withhold the one notice telling
 * somebody their account is gone.
 */
@Injectable()
export class AccountDeletionRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The closed account's language: their own choice, then their workspace's,
   * then English — the same precedence every other email here follows, minus
   * the event step, because an account notice is about no event.
   *
   * This read deliberately carries NO `deleted_at` predicate, and that is the
   * whole reason it exists rather than reusing
   * `EventRecipientsRepository.attendeeLocales`. That method filters
   * `isNull(users.deletedAt)` — correctly, since a deleted user is not a valid
   * recipient of event mail. Here the recipient is ALWAYS soft-deleted:
   * eventa-api stamps `deleted_at` in the same transaction that writes this
   * event, so the row is already marked before the message exists. Reusing the
   * shared lookup would therefore match nothing and send every closure notice
   * in English, silently, including to people who have only ever read Thai.
   *
   * `withTenant` is defence in depth, as everywhere in this service — the query
   * carries its own `organization_id` predicate.
   *
   * A row this service cannot find falls back to English. A lookup that cannot
   * be MADE — the database is down — still rejects from here, because a
   * repository's job is to report what happened, not to decide what it means.
   * The decision belongs to the caller, and
   * `AccountDeletionRequestedHandler.localeFor` makes it the same way for EVERY
   * failure: warn, count it, and write the notice in {@link DEFAULT_LOCALE}
   * anyway. So nothing this method rejects with can stop the notice, whatever
   * it is — see `common/db/refinement-read.ts`.
   */
  async noticeLocale(organizationId: number, userId: string): Promise<Locale> {
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
