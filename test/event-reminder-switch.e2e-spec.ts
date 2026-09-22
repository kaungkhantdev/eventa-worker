// A whole reminder sweep against the real database, with the mail captured.
// Deliberately NOT AppModule: booting it starts the RabbitMQ consumer and the
// crons, which would chew unrelated messages and sweep on their own clock.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';
process.env.PUBLIC_WEB_URL ??= 'http://localhost:5173';
// The events below start 20h after the clock, so the lead must be the day it
// defaults to — whatever a developer's .env says.
process.env.EVENT_REMINDER_LEAD_HOURS = '24';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import {
  type EmailMessage,
  EmailProvider,
} from '../src/common/email/email.provider';
import {
  IdempotencyService,
  type SentLedger,
} from '../src/common/idempotency/idempotency.service';
import { MessageTemplatesRepository } from '../src/common/messaging/message-templates.repository';
import { Clock } from '../src/common/time/clock';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/db/database.module';
import { EventRecipientsRepository } from '../src/modules/events/event-recipients.repository';
import { ScheduledMessagesRepository } from '../src/modules/scheduled-messages/scheduled-messages.repository';
import { ScheduledMessagesService } from '../src/modules/scheduled-messages/scheduled-messages.service';
import { ScheduledSender } from '../src/modules/scheduled-messages/scheduled-sender';

const RUN = Date.now();
const SLUG_PREFIX = 'remsw-';
const NEVER_SLUG = `${SLUG_PREFIX}${RUN}-never`;
const ON_SLUG = `${SLUG_PREFIX}${RUN}-on`;
const NEVER_BUYER = `never-${RUN}@remsw.test`;
const ON_BUYER = `on-${RUN}@remsw.test`;
const REMINDER = 'event-reminder';
const HOUR = 60 * 60 * 1000;

/**
 * Far enough ahead that neither the running dev worker nor anybody's real
 * events share the window, and a different instant from the other suites that
 * sweep the future, so running them in parallel cannot cross them.
 */
const FAR = new Date('2093-05-01T00:00:00Z');

/** Captures every send so the test can say who was mailed. */
class CapturingEmailProvider extends EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** The Redis ledger's contract, in memory: who each run already reached. */
function inMemoryLedgers(): Pick<IdempotencyService, 'recipientLedger'> {
  const ledgers = new Map<string, Set<string>>();
  return {
    recipientLedger(messageId: string): SentLedger {
      const sent = ledgers.get(messageId) ?? new Set<string>();
      ledgers.set(messageId, sent);
      return {
        wasSent: (key) => Promise.resolve(sent.has(key)),
        markSent: (key) => {
          sent.add(key);
          return Promise.resolve();
        },
      };
    },
  };
}

/**
 * The event reminder is OFF until a workspace switches it on (US-MSG-01).
 *
 * The unit specs prove each piece; this proves the sweep as it runs: a
 * workspace that never chose sends nothing and leaves no run behind, one that
 * switched it on is reminded, and switching on later still reaches people.
 */
describe('The event reminder sweep and the organizer’s switch (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let service: ScheduledMessagesService;
  const email = new CapturingEmailProvider();
  let neverOrg: number;
  let neverEvent: string;
  let onEvent: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup(pool);

    neverOrg = await seedOrg(pool, NEVER_SLUG);
    const onOrg = await seedOrg(pool, ON_SLUG);
    await switchOn(pool, onOrg);
    neverEvent = await seedEvent(pool, neverOrg, NEVER_SLUG, NEVER_BUYER);
    onEvent = await seedEvent(pool, onOrg, ON_SLUG, ON_BUYER);

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [
        ScheduledMessagesRepository,
        ScheduledSender,
        ScheduledMessagesService,
        MessageTemplatesRepository,
        EventRecipientsRepository,
        { provide: EmailProvider, useValue: email },
        { provide: IdempotencyService, useValue: inMemoryLedgers() },
        { provide: Clock, useValue: { now: () => FAR } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = app.get(ScheduledMessagesService);
  }, 30000);

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
    await app.close();
  });

  const mailedTo = () => email.sent.map((m) => m.to);

  it('reminds only the workspace that switched it on', async () => {
    await expect(service.sendReminders()).resolves.toBe(1);
    expect(mailedTo()).toEqual([ON_BUYER]);
    expect(email.sent[0].delivery?.kind).toBe(REMINDER);
  });

  it('leaves no run behind for the workspace that never chose', async () => {
    // A claimed-but-unfinished run would read as a crashed send to be resumed.
    const runs = await pool.query<{ event_id: string }>(
      `SELECT event_id FROM event_message_runs
       WHERE event_id = ANY($1) AND kind = $2`,
      [[neverEvent, onEvent], REMINDER],
    );
    expect(runs.rows.map((r) => r.event_id)).toEqual([onEvent]);
  });

  it('reaches a workspace that switches it on inside the window, and nobody twice', async () => {
    await switchOn(pool, neverOrg);
    await expect(service.sendReminders()).resolves.toBe(1);
    expect(mailedTo()).toEqual([ON_BUYER, NEVER_BUYER]);
  });
});

async function seedOrg(pool: Pool, slug: string): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, locale) VALUES ($1, $1, 'en') RETURNING id`,
    [slug],
  );
  return Number(res.rows[0].id);
}

async function switchOn(pool: Pool, org: number): Promise<void> {
  await pool.query(
    `INSERT INTO message_templates (organization_id, slug, title, active)
     VALUES ($1, $2, 'Event reminder', true)
     ON CONFLICT (organization_id, slug) DO UPDATE SET active = true`,
    [org, REMINDER],
  );
}

/** An upcoming event starting 20h after the clock, with one confirmed buyer. */
async function seedEvent(
  pool: Pool,
  org: number,
  slug: string,
  buyer: string,
): Promise<string> {
  const startAt = new Date(FAR.getTime() + 20 * HOUR);
  const event = await pool.query<{ id: string }>(
    `INSERT INTO events (organization_id, slug, name, type, bucket, status, visibility,
                         start_at, end_at, timezone, organizer_name, published_at)
     VALUES ($1, $2, $3, 'Conference', 'active', 'upcoming', 'public',
             $4, $5, 'Asia/Bangkok', 'Remsw', now())
     RETURNING id`,
    [
      org,
      slug,
      `Event ${slug}`,
      startAt,
      new Date(startAt.getTime() + 2 * HOUR),
    ],
  );
  const eventId = event.rows[0].id;
  await pool.query(
    `INSERT INTO orders
       (organization_id, reference, event_id, buyer_name, buyer_email, seats,
        subtotal_satang, total_satang, status)
     VALUES ($1, $2, $3, 'Buyer', $4, 1, 10000, 10700, 'confirmed')`,
    [org, `${slug}-order`, eventId, buyer],
  );
  return eventId;
}

async function cleanup(pool: Pool): Promise<void> {
  // Children first; message_templates goes with its organization.
  for (const table of ['event_message_runs', 'orders', 'events']) {
    await pool.query(
      `DELETE FROM ${table} WHERE organization_id IN
         (SELECT id FROM organizations WHERE slug LIKE $1)`,
      [`${SLUG_PREFIX}%`],
    );
  }
  await pool.query(`DELETE FROM organizations WHERE slug LIKE $1`, [
    `${SLUG_PREFIX}%`,
  ]);
}
