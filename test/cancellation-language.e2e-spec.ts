process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/db/database.module';
import { EventRecipientsRepository } from '../src/modules/events/event-recipients.repository';

const RUN = Date.now();
const ORG_SLUG = `cxlang-${RUN}`;
const THAI_READER = `thai-${RUN}@cxlang.test`;
const NO_ACCOUNT = `guest-${RUN}@cxlang.test`;
const OWN_STAFF = `staff-${RUN}@cxlang.test`;

/**
 * Which language each cancellation reader gets, against the real schema.
 *
 * The handler spec mocks this repository wholesale, so nothing there executes
 * the one query that is easy to get quietly wrong: attendee accounts live in
 * the PLATFORM organization, not the organizer's workspace. Scope the lookup to
 * the workspace and it finds nobody; drop the persona filter and it matches an
 * organizer's own staff row for the same address. Either way every reader gets
 * the fallback language and nothing fails.
 */
describe('EventRecipientsRepository — language (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let repo: EventRecipientsRepository;
  let orgId: number;
  let eventId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup(pool);
    ({ orgId, eventId } = await seed(pool));

    // Deliberately NOT AppModule: booting it starts the RabbitMQ consumer.
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [EventRecipientsRepository],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    repo = app.get(EventRecipientsRepository);
  }, 30000);

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
    await app.close();
  });

  it('finds the language of somebody with an attendee account', async () => {
    const locales = await repo.attendeeLocales([THAI_READER, NO_ACCOUNT]);
    expect(locales.get(THAI_READER)).toBe('th');
  });

  it('leaves somebody without an account out, so the event’s language applies', async () => {
    const locales = await repo.attendeeLocales([NO_ACCOUNT]);
    expect(locales.has(NO_ACCOUNT)).toBe(false);
  });

  it('does not mistake an organizer’s own staff row for their attendee account', async () => {
    // Same address, persona `admin`, in the organizer's workspace. Matching it
    // would read the STAFF preference as the attendee's.
    const locales = await repo.attendeeLocales([OWN_STAFF]);
    expect(locales.has(OWN_STAFF)).toBe(false);
  });

  it('asks nothing of the database for an empty batch', async () => {
    expect((await repo.attendeeLocales([])).size).toBe(0);
  });

  it('falls back to the EVENT’s language before the workspace’s', async () => {
    await pool.query(`UPDATE events SET locale = 'th' WHERE id = $1`, [
      eventId,
    ]);
    expect(await repo.fallbackLocale(orgId, eventId)).toBe('th');
  });

  it('falls back to the workspace’s when the event names none', async () => {
    await pool.query(`UPDATE events SET locale = NULL WHERE id = $1`, [
      eventId,
    ]);
    await pool.query(`UPDATE organizations SET locale = 'th' WHERE id = $1`, [
      orgId,
    ]);
    expect(await repo.fallbackLocale(orgId, eventId)).toBe('th');
  });
});

async function seed(pool: Pool): Promise<{ orgId: number; eventId: string }> {
  const org = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, locale) VALUES ('Cxlang', $1, 'en') RETURNING id`,
    [ORG_SLUG],
  );
  const orgId = Number(org.rows[0].id);
  const event = await pool.query<{ id: string }>(
    `INSERT INTO events (organization_id, slug, name, type, bucket, status, visibility,
                         start_at, timezone, organizer_name, published_at)
     VALUES ($1, $2, 'Cxlang Summit', 'Conference', 'active', 'upcoming', 'public',
             now() + interval '30 days', 'Asia/Bangkok', 'Cxlang', now())
     RETURNING id`,
    [orgId, `${ORG_SLUG}-summit`],
  );

  // The attendee account, in the PLATFORM org — where every attendee lives.
  await pool.query(
    `INSERT INTO users (organization_id, name, email, persona, status, locale)
     SELECT id, 'Malee', $1, 'attendee', 'Active', 'th'
     FROM organizations WHERE slug = 'eventa'`,
    [THAI_READER],
  );
  // A staff member of the ORGANIZER's workspace who prefers Thai. Their row
  // must not be read as anybody's attendee preference.
  await pool.query(
    `INSERT INTO users (organization_id, name, email, persona, status, locale)
     VALUES ($1, 'Staff', $2, 'admin', 'Active', 'th')`,
    [orgId, OWN_STAFF],
  );
  return { orgId, eventId: event.rows[0].id };
}

async function cleanup(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM users WHERE email LIKE '%@cxlang.test'`);
  await pool.query(`DELETE FROM organizations WHERE slug LIKE 'cxlang-%'`);
}
