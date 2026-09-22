import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/drizzle.constants';
import { messageTemplates } from '../../db/schema';
import type { MessageChannel } from '../../db/schema/messaging';
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
   * Whether this message goes out ON THIS CHANNEL (US-DISC-06 AC5).
   *
   * Two conditions, because they answer different questions: `active` is the
   * message's kill switch, and `channels` is which ways it leaves. A message
   * that is off is off on every channel; a message that is on may still not be
   * texted.
   *
   * An ABSENT row means the API CATALOG's channels for that slug — which is
   * why this may only be asked about a channel the catalog actually gives the
   * slug. Asking `sendsOn(org, 'event-reminder', 'sms')` would answer true for
   * every workspace that never opened its settings and text people about a
   * channel the catalog does not list.
   *
   * The stored row is a COPY of the catalog taken when the workspace first
   * touched the message, so rows written before a slug gained a channel hold
   * the old list. eventa-api's migration 0066 backfills those; without it a
   * workspace that once reworded its confirmation would silently get no texts
   * while its card showed an SMS badge.
   */
  async sendsOn(
    organizationId: number,
    slug: string,
    channel: MessageChannel,
  ): Promise<boolean> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({
          active: messageTemplates.active,
          channels: messageTemplates.channels,
        })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.organizationId, organizationId),
            eq(messageTemplates.slug, slug),
          ),
        )
        .limit(1);
      if (!row) return activeWhenUnset(slug);
      return row.active && row.channels.includes(channel);
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
