process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/db/database.module';
import { ScheduledMessagesRepository } from '../src/modules/scheduled-messages/scheduled-messages.repository';

const RUN = Date.now();
const ORG_SLUG = `schmsg-${RUN}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Which events get a scheduled message, against the real schema
 * (US-MSG-01/08).
 *
 * Both "due" queries are hand-written SQL deciding who gets EMAILED, so they
 * are proven here rather than trusted. Each exclusion below is a way of
 * emailing people who should not be emailed.
 */
describe('ScheduledMessagesRepository (e2e — US-MSG-01/08)', () => {
  let app: INestApplication;
  let pool: Pool;
  let repo: ScheduledMessagesRepository;
  let orgId: number;
  const now = new Date();
  const window = { now, delayMs: DAY, windowMs: 7 * DAY, limit: 50 };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup(pool);
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, locale) VALUES ('Schmsg', $1, 'en') RETURNING id`,
      [ORG_SLUG],
    );
    orgId = Number(org.rows[0].id);

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [ScheduledMessagesRepository],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    repo = app.get(ScheduledMessagesRepository);
  }, 30000);

  afterEach(async () => {
    await pool.query(
      `DELETE FROM event_message_runs WHERE organization_id = $1`,
      [orgId],
    );
    await pool.query(`DELETE FROM surveys WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM events WHERE organization_id = $1`, [orgId]);
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
    await app.close();
  });

  let seq = 0;
  async function event(o: {
    endedAgo?: number;
    startsIn?: number;
    status?: string;
    survey?: 'live' | 'draft' | null;
  }): Promise<string> {
    seq += 1;
    // Either an event that already ENDED, or one that STARTS later; the other
    // end is two hours away from the given one.
    const ended =
      o.startsIn !== undefined
        ? new Date(now.getTime() + o.startsIn + 2 * HOUR)
        : new Date(now.getTime() - (o.endedAgo ?? 0));
    const res = await pool.query<{ id: string }>(
      `INSERT INTO events (organization_id, slug, name, type, bucket, status, visibility,
                           start_at, end_at, timezone, organizer_name, published_at)
       VALUES ($1, $2, $3, 'Conference', 'completed', $4, 'public',
               $5, $6, 'Asia/Bangkok', 'Schmsg', now())
       RETURNING id`,
      [
        orgId,
        `${ORG_SLUG}-${seq}`,
        `Event ${seq}`,
        o.status ?? 'completed',
        new Date(ended.getTime() - 2 * HOUR),
        ended,
      ],
    );
    const id = res.rows[0].id;
    if (o.survey !== null) {
      await pool.query(
        `INSERT INTO surveys (organization_id, event_id, title, status)
         VALUES ($1, $2, 'Feedback', $3::survey_status)`,
        [orgId, id, o.survey ?? 'live'],
      );
    }
    return id;
  }

  const dueIds = async () =>
    (await repo.thankYousDue(window)).map((e) => e.eventId);

  const remindIds = async () =>
    (await repo.remindersDue({ now, leadMs: DAY, limit: 50 })).map(
      (e) => e.eventId,
    );

  describe('the reminder', () => {
    it('picks an event starting within the day', async () => {
      const id = await event({ startsIn: 20 * HOUR, survey: null });
      expect(await remindIds()).toContain(id);
    });

    it('waits for an event more than a day away', async () => {
      const id = await event({ startsIn: 3 * DAY, survey: null });
      expect(await remindIds()).not.toContain(id);
    });

    it('never reminds anybody about an event that has already begun', async () => {
      const id = await event({ endedAgo: HOUR, survey: null });
      expect(await remindIds()).not.toContain(id);
    });

    it('never reminds anybody about a cancelled event', async () => {
      const id = await event({
        startsIn: 20 * HOUR,
        status: 'cancelled',
        survey: null,
      });
      expect(await remindIds()).not.toContain(id);
    });

    it('does not need a survey — every event gets one', async () => {
      const id = await event({ startsIn: 20 * HOUR, survey: null });
      expect(await remindIds()).toContain(id);
    });

    it('does not remind twice, but a finished THANK-YOU does not count', async () => {
      // The kinds are independent: one being done must not suppress the other.
      const id = await event({ startsIn: 20 * HOUR, survey: null });
      await repo.claim(
        { organizationId: orgId, eventId: id },
        'post-event-thankyou',
        now,
      );
      await repo.complete(
        { organizationId: orgId, eventId: id },
        'post-event-thankyou',
        now,
      );
      expect(await remindIds()).toContain(id);

      await repo.claim(
        { organizationId: orgId, eventId: id },
        'event-reminder',
        now,
      );
      await repo.complete(
        { organizationId: orgId, eventId: id },
        'event-reminder',
        now,
      );
      expect(await remindIds()).not.toContain(id);
    });
  });

  it('picks an event that ended yesterday and has a live survey', async () => {
    const id = await event({ endedAgo: 2 * DAY });
    expect(await dueIds()).toContain(id);
  });

  it('waits until the delay has passed — not while people are leaving', async () => {
    const id = await event({ endedAgo: HOUR });
    expect(await dueIds()).not.toContain(id);
  });

  it('ignores an event older than the window', async () => {
    // Without this, the first run after deploying would thank everybody who
    // ever attended anything.
    const id = await event({ endedAgo: 30 * DAY });
    expect(await dueIds()).not.toContain(id);
  });

  it('never thanks anybody for a cancelled event', async () => {
    const id = await event({ endedAgo: 2 * DAY, status: 'cancelled' });
    expect(await dueIds()).not.toContain(id);
  });

  it('sends no link to a survey that is not taking answers', async () => {
    const draft = await event({ endedAgo: 2 * DAY, survey: 'draft' });
    const none = await event({ endedAgo: 2 * DAY, survey: null });
    const due = await dueIds();
    expect(due).not.toContain(draft);
    expect(due).not.toContain(none);
  });

  it('leaves an event alone once its thank-you has finished', async () => {
    const id = await event({ endedAgo: 2 * DAY });
    await repo.claim(
      { organizationId: orgId, eventId: id },
      'post-event-thankyou',
      now,
    );
    await repo.complete(
      { organizationId: orgId, eventId: id },
      'post-event-thankyou',
      now,
    );
    expect(await dueIds()).not.toContain(id);
  });

  it('comes back to an event whose run started but did not finish', async () => {
    // A crashed run must be resumable. The ledger stops anybody it already
    // reached being thanked twice.
    const id = await event({ endedAgo: 2 * DAY });
    await repo.claim(
      { organizationId: orgId, eventId: id },
      'post-event-thankyou',
      now,
    );
    expect(await dueIds()).toContain(id);
  });

  it('can be claimed twice without failing', async () => {
    const id = await event({ endedAgo: 2 * DAY });
    const target = { organizationId: orgId, eventId: id };
    await repo.claim(target, 'post-event-thankyou', now);
    await expect(
      repo.claim(target, 'post-event-thankyou', now),
    ).resolves.toBeUndefined();
    const rows = await pool.query(
      `SELECT 1 FROM event_message_runs WHERE event_id = $1`,
      [id],
    );
    expect(rows.rowCount).toBe(1);
  });
});

async function cleanup(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM organizations WHERE slug LIKE 'schmsg-%'`);
}
