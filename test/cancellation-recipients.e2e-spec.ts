process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/db/database.module';
import { EventRecipientsRepository } from '../src/modules/events/event-recipients.repository';

const RUN = Date.now();
const ORG_SLUG = `cxrcpt-${RUN}`;
const DOMAIN = '@cxrcpt.test';
const PRICE_SATANG = 105_000;
const APPROVAL_ASKED = '2026-09-01T00:00:00Z';

interface Seeded {
  email: string;
  status: string;
  paymentStatus: string;
  approvalRequestedAt: string | null;
}

/**
 * Who is told that an event is cancelled, against the real schema (US-EVT-08,
 * US-REG-02). The handler spec mocks this repository, so nothing there runs
 * the query — and the query is the whole rule: a confirmed attendee, and a
 * registration still waiting for the organizer's approval (paid or free),
 * are told; an order still waiting for its money, or already decided, is not.
 */
describe('EventRecipientsRepository — cancellation recipients (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let repo: EventRecipientsRepository;
  let orgId: number;
  let eventId: string;
  let seq = 0;

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

    for (const order of ORDERS) await placeOrder(order);
  }, 30000);

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
    await app.close();
  });

  const ORDERS: Seeded[] = [
    {
      email: `confirmed${DOMAIN}`,
      status: 'confirmed',
      paymentStatus: 'paid',
      approvalRequestedAt: null,
    },
    {
      email: `paid-waiting${DOMAIN}`,
      status: 'pending',
      paymentStatus: 'paid',
      approvalRequestedAt: APPROVAL_ASKED,
    },
    {
      email: `free-waiting${DOMAIN}`,
      status: 'pending',
      paymentStatus: 'pending',
      approvalRequestedAt: APPROVAL_ASKED,
    },
    {
      email: `still-paying${DOMAIN}`,
      status: 'pending',
      paymentStatus: 'pending',
      approvalRequestedAt: null,
    },
    {
      email: `rejected${DOMAIN}`,
      status: 'rejected',
      paymentStatus: 'refunded',
      approvalRequestedAt: APPROVAL_ASKED,
    },
    // One person with a ticket AND a registration still waiting: one email,
    // worded for the ticket they hold.
    {
      email: `both${DOMAIN}`,
      status: 'confirmed',
      paymentStatus: 'paid',
      approvalRequestedAt: null,
    },
    {
      email: `both${DOMAIN}`,
      status: 'pending',
      paymentStatus: 'paid',
      approvalRequestedAt: APPROVAL_ASKED,
    },
  ];

  async function placeOrder(o: Seeded): Promise<void> {
    seq += 1;
    await pool.query(
      `INSERT INTO orders (organization_id, reference, event_id, buyer_name, buyer_email,
                           status, payment_status, seats, subtotal_satang, vat_amount_satang,
                           total_satang, requires_approval, approval_requested_at)
       VALUES ($1, $2, $3, 'Anan', $4, $5, $6, 1, $7, 0, $7, $8, $9)`,
      [
        orgId,
        `CXR-${RUN}-${seq}`,
        eventId,
        o.email,
        o.status,
        o.paymentStatus,
        PRICE_SATANG,
        o.approvalRequestedAt !== null,
        o.approvalRequestedAt,
      ],
    );
  }

  const byEmail = async () =>
    new Map(
      (await repo.cancellationRecipients(orgId, eventId)).map((r) => [
        r.email,
        r,
      ]),
    );

  it('tells a confirmed attendee', async () => {
    expect((await byEmail()).get(`confirmed${DOMAIN}`)).toMatchObject({
      awaitingApproval: false,
    });
  });

  it('tells a registration paid for and waiting for approval — its money is owed back', async () => {
    expect((await byEmail()).get(`paid-waiting${DOMAIN}`)).toMatchObject({
      awaitingApproval: true,
    });
  });

  it('tells a free registration waiting for approval', async () => {
    expect((await byEmail()).get(`free-waiting${DOMAIN}`)).toMatchObject({
      awaitingApproval: true,
    });
  });

  it('does not tell an order still waiting for its money, or one already turned down', async () => {
    const recipients = await byEmail();
    expect(recipients.has(`still-paying${DOMAIN}`)).toBe(false);
    expect(recipients.has(`rejected${DOMAIN}`)).toBe(false);
  });

  it('writes once to someone with a ticket and a waiting registration, as a ticket holder', async () => {
    const all = await repo.cancellationRecipients(orgId, eventId);
    expect(all.filter((r) => r.email === `both${DOMAIN}`)).toEqual([
      { email: `both${DOMAIN}`, name: 'Anan', awaitingApproval: false },
    ]);
  });

  it('leaves the confirmed-attendee list — what “Email all” reaches — as it was', async () => {
    const confirmed = await repo.confirmedRecipients(orgId, eventId);
    expect(confirmed.map((r) => r.email).sort()).toEqual(
      [`both${DOMAIN}`, `confirmed${DOMAIN}`].sort(),
    );
  });
});

async function seed(pool: Pool): Promise<{ orgId: number; eventId: string }> {
  const org = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, locale) VALUES ('Cxrcpt', $1, 'en') RETURNING id`,
    [ORG_SLUG],
  );
  const orgId = Number(org.rows[0].id);
  const event = await pool.query<{ id: string }>(
    `INSERT INTO events (organization_id, slug, name, type, bucket, status, visibility,
                         start_at, timezone, organizer_name, published_at)
     VALUES ($1, $2, 'Cxrcpt Summit', 'Conference', 'active', 'upcoming', 'public',
             now() + interval '30 days', 'Asia/Bangkok', 'Cxrcpt', now())
     RETURNING id`,
    [orgId, `${ORG_SLUG}-summit`],
  );
  return { orgId, eventId: event.rows[0].id };
}

async function cleanup(pool: Pool): Promise<void> {
  const orgs = `SELECT id FROM organizations WHERE slug LIKE 'cxrcpt-%'`;
  for (const table of ['orders', 'events']) {
    await pool.query(`DELETE FROM ${table} WHERE organization_id IN (${orgs})`);
  }
  await pool.query(`DELETE FROM organizations WHERE slug LIKE 'cxrcpt-%'`);
}
