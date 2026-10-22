// The attendee's own "Event reminders" switch, against the real schema, with
// the mail captured. Deliberately NOT AppModule: booting it starts the RabbitMQ
// consumer and the crons, which would chew unrelated messages and sweep on
// their own clock.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';
process.env.PUBLIC_WEB_URL ??= 'http://localhost:5173';
// The event below starts 20h after the clock and the other ended two days
// before it, so these must be the values they default to — whatever a
// developer's .env says.
process.env.EVENT_REMINDER_LEAD_HOURS = '24';
process.env.FEEDBACK_REQUEST_DELAY_HOURS = '24';
process.env.FEEDBACK_REQUEST_WINDOW_DAYS = '7';

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
const SLUG = `remopt-${RUN}`;
const DOMAIN = '@remopt.test';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Switched "Event reminders" off in the attendee portal. */
const OPTED_OUT = `off-${RUN}${DOMAIN}`;
/** The same switch, off — but the order was typed with different capitals. */
const OPTED_OUT_ACCOUNT = `typed-${RUN}${DOMAIN}`;
const OPTED_OUT_AS_TYPED = `Typed-${RUN}${DOMAIN.toUpperCase()}`;
/** Touched the switch and left it on. */
const LEFT_ON = `on-${RUN}${DOMAIN}`;
/** Switched MARKETING off, which says nothing about reminders. */
const MARKETING_OFF = `mkt-${RUN}${DOMAIN}`;
/** No account at all: nobody ever chose, so the default — on — holds. */
const GUEST = `guest-${RUN}${DOMAIN}`;
/**
 * A staff row in the organizer's own workspace with a reminder row off. It is
 * not an attendee account, so it is not this buyer's choice.
 */
const STAFF = `staff-${RUN}${DOMAIN}`;

/**
 * Far enough ahead that neither the running dev worker nor anybody's real
 * events share the window, and a different instant from the other suites that
 * sweep the future, so they cannot cross.
 */
const FAR = new Date('2094-02-01T00:00:00Z');

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
 * "Given the Settings tab, when I toggle … event reminders …, then my choice
 * is saved and applied to future messages" (US-DISC-12).
 *
 * eventa-api saves the choice in `notification_preferences`; this proves the
 * day-before reminder actually reads it — and that it reads the RIGHT row:
 * the attendee account in the platform organization, the reminder topic only,
 * and only the email channel the reminder is sent on.
 */
describe('The event reminder and the attendee’s own switch (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let service: ScheduledMessagesService;
  let recipients: EventRecipientsRepository;
  const email = new CapturingEmailProvider();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup(pool);
    await seed(pool);

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
    recipients = app.get(EventRecipientsRepository);
  }, 30000);

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
    await app.close();
  });

  beforeEach(() => {
    email.sent.length = 0;
  });

  const mailed = (kind: string) =>
    email.sent
      .filter((m) => m.delivery?.kind === kind)
      .map((m) => m.to)
      .sort();

  it('reminds everybody except those who switched reminders off', async () => {
    await expect(service.sendReminders()).resolves.toBe(1);
    expect(mailed('event-reminder')).toEqual(
      [LEFT_ON, MARKETING_OFF, GUEST, STAFF].sort(),
    );
  });

  it('still thanks them after the event — the switch is about reminders', async () => {
    await expect(service.sendThankYous()).resolves.toBe(1);
    expect(mailed('post-event-thankyou')).toContain(OPTED_OUT);
  });

  it('answers in the addresses it was asked about, whatever their capitals', async () => {
    const off = await recipients.emailOptOuts(
      [OPTED_OUT, OPTED_OUT_AS_TYPED, LEFT_ON, GUEST],
      'reminder',
    );
    expect([...off].sort()).toEqual([OPTED_OUT, OPTED_OUT_AS_TYPED].sort());
  });

  it('asks nothing of the database for an empty batch', async () => {
    expect((await recipients.emailOptOuts([], 'reminder')).size).toBe(0);
  });
});

async function seed(pool: Pool): Promise<void> {
  const org = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, locale) VALUES ('Remopt', $1, 'en') RETURNING id`,
    [SLUG],
  );
  const orgId = Number(org.rows[0].id);
  // The reminder is off until a workspace switches it on (US-MSG-01).
  await pool.query(
    `INSERT INTO message_templates (organization_id, slug, title, active)
     VALUES ($1, 'event-reminder', 'Event reminder', true)`,
    [orgId],
  );

  const buyers = [
    OPTED_OUT,
    OPTED_OUT_AS_TYPED,
    LEFT_ON,
    MARKETING_OFF,
    GUEST,
    STAFF,
  ];
  const upcoming = new Date(FAR.getTime() + 20 * HOUR);
  const ended = new Date(FAR.getTime() - 2 * DAY);
  await seedEvent(pool, orgId, 'upcoming', upcoming, buyers);
  const thanked = await seedEvent(pool, orgId, 'completed', ended, buyers);
  await pool.query(
    `INSERT INTO surveys (organization_id, event_id, title, status)
     VALUES ($1, $2, 'Feedback', 'live')`,
    [orgId, thanked],
  );

  await attendee(pool, OPTED_OUT, { reminder: false });
  await attendee(pool, OPTED_OUT_ACCOUNT, { reminder: false });
  await attendee(pool, LEFT_ON, { reminder: true });
  await attendee(pool, MARKETING_OFF, { marketing: false });
  const staff = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, persona, status)
     VALUES ($1, 'Staff', $2, 'admin', 'Active') RETURNING id`,
    [orgId, STAFF],
  );
  await pool.query(
    `INSERT INTO notification_preferences (organization_id, user_id, category, email_enabled)
     VALUES ($1, $2, 'reminder', false)`,
    [orgId, staff.rows[0].id],
  );
}

/** An attendee account in the PLATFORM org, with the switches given. */
async function attendee(
  pool: Pool,
  address: string,
  switches: Partial<Record<'reminder' | 'marketing', boolean>>,
): Promise<void> {
  const user = await pool.query<{ id: string; organization_id: string }>(
    `INSERT INTO users (organization_id, name, email, persona, status)
     SELECT id, 'Attendee', $1, 'attendee', 'Active'
     FROM organizations WHERE slug = 'eventa'
     RETURNING id, organization_id`,
    [address],
  );
  const { id, organization_id } = user.rows[0];
  for (const [category, on] of Object.entries(switches)) {
    await pool.query(
      `INSERT INTO notification_preferences (organization_id, user_id, category, email_enabled)
       VALUES ($1, $2, $3, $4)`,
      [organization_id, id, category, on],
    );
  }
}

/** An event in the given status, with one confirmed order per buyer. */
async function seedEvent(
  pool: Pool,
  org: number,
  status: 'upcoming' | 'completed',
  startAt: Date,
  buyers: string[],
): Promise<string> {
  const event = await pool.query<{ id: string }>(
    `INSERT INTO events (organization_id, slug, name, type, bucket, status, visibility,
                         start_at, end_at, timezone, organizer_name, published_at)
     VALUES ($1, $2, $3, 'Conference', $4, $5, 'public',
             $6, $7, 'Asia/Bangkok', 'Remopt', now())
     RETURNING id`,
    [
      org,
      `${SLUG}-${status}`,
      `Remopt ${status}`,
      status === 'upcoming' ? 'active' : 'completed',
      status,
      startAt,
      new Date(startAt.getTime() + 2 * HOUR),
    ],
  );
  const eventId = event.rows[0].id;
  for (const [i, buyer] of buyers.entries()) {
    await pool.query(
      `INSERT INTO orders
         (organization_id, reference, event_id, buyer_name, buyer_email, seats,
          subtotal_satang, total_satang, status)
       VALUES ($1, $2, $3, 'Buyer', $4, 1, 10000, 10700, 'confirmed')`,
      [org, `${SLUG}-${status}-${i}`, eventId, buyer],
    );
  }
  return eventId;
}

async function cleanup(pool: Pool): Promise<void> {
  // Preferences go with their user; templates and surveys with their org.
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  for (const table of ['event_message_runs', 'surveys', 'orders', 'events']) {
    await pool.query(
      `DELETE FROM ${table} WHERE organization_id IN
         (SELECT id FROM organizations WHERE slug LIKE 'remopt-%')`,
    );
  }
  await pool.query(`DELETE FROM organizations WHERE slug LIKE 'remopt-%'`);
}
