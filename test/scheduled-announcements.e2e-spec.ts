process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/db/database.module';
import {
  type DueSweepResult,
  ScheduledAnnouncementsRepository,
} from '../src/modules/scheduled-announcements/scheduled-announcements.repository';

const RUN = Date.now();
/** Specific enough that the cleanup's LIKE can only ever match this suite's orgs. */
const SLUG_PREFIX = 'san-e2e-';
const ORG_SLUG = `${SLUG_PREFIX}${RUN}`;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const BATCH = 50;
const ATTENDEES_EMAIL = 'events.attendees_email_requested';

/**
 * Sending scheduled announcements when they fall due, against the real schema
 * (US-MSG-04/05, TC-MSG-10a/11/12).
 *
 * This is the one place a scheduled announcement turns into email, and it
 * races the organizer: they can cancel or move it right up to the moment the
 * sweep claims it. What must hold is proved here rather than trusted — a due
 * one goes exactly once, a cancelled or future one never, and a row somebody
 * else has locked is left for them.
 *
 * The sweep is cross-tenant, so every assertion reads only this suite's own
 * organization.
 */
describe('Sending scheduled announcements (e2e — US-MSG-04/05)', () => {
  let app: INestApplication;
  let pool: Pool;
  let repo: ScheduledAnnouncementsRepository;
  let orgId: number;
  let authorId: string;
  let eventId: string;
  let goneEventId: string;
  let seq = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup(pool);
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, locale) VALUES ('San', $1, 'en') RETURNING id`,
      [ORG_SLUG],
    );
    orgId = Number(org.rows[0].id);
    const author = await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email) VALUES ($1, 'Anan', $2) RETURNING id`,
      [orgId, `author@${ORG_SLUG}.test`],
    );
    authorId = author.rows[0].id;
    eventId = await event('summit');
    goneEventId = await event('gone');
    await pool.query(`UPDATE events SET deleted_at = now() WHERE id = $1`, [
      goneEventId,
    ]);

    // Two attendees, not three: one of them registered twice. A cancelled
    // registration is nobody's audience.
    await order('a@san.test', 'confirmed');
    await order('a@san.test', 'confirmed');
    await order('b@san.test', 'confirmed');
    await order('c@san.test', 'cancelled');

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [ScheduledAnnouncementsRepository],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    repo = app.get(ScheduledAnnouncementsRepository);
  }, 30000);

  afterEach(async () => {
    await pool.query(`DELETE FROM outbox_events WHERE organization_id = $1`, [
      orgId,
    ]);
    await pool.query(`DELETE FROM announcements WHERE organization_id = $1`, [
      orgId,
    ]);
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
    await app.close();
  });

  async function event(name: string): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO events (organization_id, slug, name, type, bucket, status, visibility,
                           start_at, timezone, organizer_name, published_at)
       VALUES ($1, $2, $3, 'Conference', 'active', 'upcoming', 'public',
               now() + interval '30 days', 'Asia/Bangkok', 'San', now())
       RETURNING id`,
      [orgId, `${ORG_SLUG}-${name}`, `San ${name}`],
    );
    return res.rows[0].id;
  }

  async function order(email: string, status: string): Promise<void> {
    seq += 1;
    await pool.query(
      `INSERT INTO orders (organization_id, reference, event_id, buyer_name, buyer_email,
                           status, payment_status, seats, subtotal_satang, vat_amount_satang,
                           total_satang)
       VALUES ($1, $2, $3, 'Attendee', $4, $5::order_status, 'paid', 1, 0, 0, 0)`,
      [orgId, `SAN-${RUN}-${seq}`, eventId, email, status],
    );
  }

  /** An announcement in whatever state a case needs, straight into the table. */
  async function announcement(a: {
    dueInMs: number;
    status?: 'scheduled' | 'cancelled' | 'sent';
    eventId?: string;
    author?: string | null;
  }): Promise<number> {
    const status = a.status ?? 'scheduled';
    const scheduledFor = new Date(Date.now() + a.dueInMs);
    const res = await pool.query<{ id: string }>(
      `INSERT INTO announcements (organization_id, event_id, subject, body, sent_by_user_id,
                                  status, scheduled_for, sent_at, recipient_count, cancelled_at)
       VALUES ($1, $2, 'Doors at 6', 'See you in Hall B', $3, $4::announcement_status, $5,
               CASE WHEN $4 = 'sent' THEN now() END,
               CASE WHEN $4 = 'sent' THEN 5 END,
               CASE WHEN $4 = 'cancelled' THEN now() END)
       RETURNING id`,
      [
        orgId,
        a.eventId ?? eventId,
        a.author === undefined ? authorId : a.author,
        status,
        scheduledFor,
      ],
    );
    return Number(res.rows[0].id);
  }

  const sweep = (now = new Date()) => repo.sendDue({ now, limit: BATCH });

  /** This suite's part of a cross-tenant sweep. */
  const ours = (result: DueSweepResult) => ({
    sent: result.sent.filter((a) => a.organizationId === orgId),
    dropped: result.dropped.filter((a) => a.organizationId === orgId),
  });

  const row = async (id: number) =>
    (
      await pool.query<{
        status: string;
        sent_at: Date | null;
        recipient_count: string | null;
        cancelled_at: Date | null;
        cancelled_by_user_id: string | null;
      }>(
        `SELECT status, sent_at, recipient_count, cancelled_at, cancelled_by_user_id
         FROM announcements WHERE id = $1`,
        [id],
      )
    ).rows[0];

  const sends = async () =>
    (
      await pool.query<{
        aggregate_type: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT aggregate_type, aggregate_id, payload FROM outbox_events
         WHERE organization_id = $1 AND routing_key = $2 ORDER BY id`,
        [orgId, ATTENDEES_EMAIL],
      )
    ).rows;

  it('sends a due one: marks it sent, counts the audience now, and queues the same send the API does', async () => {
    const id = await announcement({ dueInMs: -MINUTE });
    const now = new Date();

    const result = ours(await sweep(now));

    expect(result.sent).toEqual([
      { id, organizationId: orgId, recipientCount: 2 },
    ]);
    const sent = await row(id);
    expect(sent.status).toBe('sent');
    expect(sent.sent_at?.toISOString()).toBe(now.toISOString());
    expect(Number(sent.recipient_count)).toBe(2);
    expect(await sends()).toEqual([
      {
        aggregate_type: 'event',
        aggregate_id: eventId,
        payload: {
          version: 1,
          organizationId: orgId,
          eventId,
          subject: 'Doors at 6',
          message: 'See you in Hall B',
          requestedByUserId: authorId,
          recipientCount: 2,
          occurredAt: now.toISOString(),
        },
      },
    ]);
  });

  it('leaves one still to come, and never sends a cancelled or already-sent one', async () => {
    const future = await announcement({ dueInMs: DAY });
    const cancelled = await announcement({
      dueInMs: -MINUTE,
      status: 'cancelled',
    });
    const alreadySent = await announcement({ dueInMs: -DAY, status: 'sent' });

    const result = ours(await sweep());

    expect(result.sent).toEqual([]);
    expect((await row(future)).status).toBe('scheduled');
    expect((await row(cancelled)).status).toBe('cancelled');
    expect((await row(alreadySent)).status).toBe('sent');
    expect(await sends()).toEqual([]);
  });

  it('drops a due one whose event has been deleted — cancelled by nobody, and never sent', async () => {
    // A send-now to a deleted event is a 404. Sending it later anyway would
    // write to the attendees of an event the organizer took down.
    const id = await announcement({ dueInMs: -MINUTE, eventId: goneEventId });

    const result = ours(await sweep());

    expect(result.dropped).toEqual([{ id, organizationId: orgId }]);
    const dropped = await row(id);
    expect(dropped.status).toBe('cancelled');
    expect(dropped.cancelled_at).not.toBeNull();
    expect(dropped.cancelled_by_user_id).toBeNull();
    expect(dropped.sent_at).toBeNull();
    expect(await sends()).toEqual([]);
  });

  it('sends each one once, however many times it sweeps', async () => {
    await announcement({ dueInMs: -MINUTE });

    await sweep();
    const again = ours(await sweep());

    expect(again.sent).toEqual([]);
    expect(await sends()).toHaveLength(1);
  });

  it('sends each one once when two sweeps race', async () => {
    const first = await announcement({ dueInMs: -2 * MINUTE });
    const second = await announcement({ dueInMs: -MINUTE });

    const [a, b] = await Promise.all([sweep(), sweep()]);

    const sentIds = [...ours(a).sent, ...ours(b).sent].map((s) => s.id).sort();
    expect(sentIds).toEqual([first, second].sort());
    const aggregateSends = await sends();
    expect(aggregateSends).toHaveLength(2);
  });

  it('skips one somebody else holds, and never sends it once they cancel it (TC-MSG-11)', async () => {
    // The organizer's cancel holds the row while it commits. The sweep must
    // not wait for it, nor send it — and afterwards there is nothing to send.
    const id = await announcement({ dueInMs: -MINUTE });
    const organizer = await pool.connect();
    try {
      await organizer.query('BEGIN');
      await organizer.query(
        `SELECT id FROM announcements WHERE id = $1 FOR UPDATE`,
        [id],
      );

      const whileHeld = ours(await sweep());
      expect(whileHeld.sent).toEqual([]);

      await organizer.query(
        `UPDATE announcements SET status = 'cancelled', cancelled_at = now()
         WHERE id = $1`,
        [id],
      );
      await organizer.query('COMMIT');
    } finally {
      organizer.release();
    }

    const afterwards = ours(await sweep());
    expect(afterwards.sent).toEqual([]);
    expect((await row(id)).status).toBe('cancelled');
    expect(await sends()).toEqual([]);
  });

  it('still sends one whose author has since left the workspace', async () => {
    const id = await announcement({ dueInMs: -MINUTE, author: null });

    const result = ours(await sweep());

    expect(result.sent.map((s) => s.id)).toEqual([id]);
    const [send] = await sends();
    expect(send.payload.requestedByUserId).toBeNull();
  });
});

async function cleanup(pool: Pool): Promise<void> {
  const orgs = `SELECT id FROM organizations WHERE slug LIKE '${SLUG_PREFIX}%'`;
  for (const table of [
    'outbox_events',
    'announcements',
    'orders',
    'events',
    'users',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE organization_id IN (${orgs})`);
  }
  await pool.query(
    `DELETE FROM organizations WHERE slug LIKE '${SLUG_PREFIX}%'`,
  );
}
