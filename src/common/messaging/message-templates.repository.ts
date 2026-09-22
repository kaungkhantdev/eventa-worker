import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { messageTemplates } from '../../db/schema';
import { withTenant } from '../../db/tenant';
import { activeWhenUnset } from './template-defaults';

/** The organizer's own wording for one message, per language (US-MSG-02). */
export interface TemplateWording {
  subjectEn: string | null;
  bodyEn: string | null;
  subjectTh: string | null;
  bodyTh: string | null;
}

/**
 * The organizer's kill switch for one automated message (US-MSG-01).
 *
 * Shared rather than per-module: every handler that sends an automated message
 * has to ask the same question, and two copies of "what does an absent row
 * mean" is exactly the kind of duplication that ends with one message honouring
 * a setting and another ignoring it.
 *
 * eventa-api owns the table and the catalog of slugs; this only reads. The read
 * runs inside `withTenant` so RLS scopes it — an unscoped read would return no
 * row, and no row means the slug's default (ACTIVE for all but the reminder),
 * so getting this wrong would send a message the organizer had switched off.
 */
@Injectable()
export class MessageTemplatesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Whether the organizer has this message switched on. An ABSENT row means
   * the slug's default ({@link activeWhenUnset}): on, so a workspace that has
   * never opened its message settings still sends its confirmations — except
   * the event reminder, which waits until a workspace switches it on.
   */
  async isActive(organizationId: number, slug: string): Promise<boolean> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({ active: messageTemplates.active })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.organizationId, organizationId),
            eq(messageTemplates.slug, slug),
          ),
        )
        .limit(1);
      return row?.active ?? activeWhenUnset(slug);
    });
  }

  /**
   * What the organizer wrote, where they wrote any (US-MSG-02).
   *
   * Every field can be null independently: somebody may have rewritten the
   * English and left the Thai to Eventa. The caller falls back per FIELD, not
   * per template, so a half-filled row never sends a blank.
   */
  async wordingFor(
    organizationId: number,
    slug: string,
  ): Promise<TemplateWording> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({
          subjectEn: messageTemplates.emailSubjectEn,
          bodyEn: messageTemplates.emailBodyEn,
          subjectTh: messageTemplates.emailSubjectTh,
          bodyTh: messageTemplates.emailBodyTh,
        })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.organizationId, organizationId),
            eq(messageTemplates.slug, slug),
          ),
        )
        .limit(1);
      return (
        row ?? { subjectEn: null, bodyEn: null, subjectTh: null, bodyTh: null }
      );
    });
  }
}
