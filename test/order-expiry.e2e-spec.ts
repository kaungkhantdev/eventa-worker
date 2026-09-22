process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/db/database.module';
import { OrderExpiryRepository } from '../src/modules/order-expiry/order-expiry.repository';

const RUN = Date.now();
const ORG_SLUG = `oexp-${RUN}`;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PRICE = 100_000;
/**
 * The sweep is cross-tenant by design, so it may meet other lapsed orders in a
 * shared local database; a limit well above that keeps this suite's rows from
 * being left for a later sweep by chance.
 */
const SWEEP_LIMIT = 1_000;

/**
 * The unpaid-order sweep, against the real schema — and what it must leave
 * alone (US-DISC-05, US-REG-02).
 *
 * A registration waiting for the organizer's approval is on the ORGANIZER's
 * clock, not the buyer's: a paid one has paid, and a free one owes nothing.
 * Expiring either would throw away a decision nobody has made yet — for a
 * paid one, with the buyer's money still taken.
 */
describe('Expiring unpaid orders (e2e — US-DISC-05, US-REG-02)', () => {
  let app: INestApplication;
  let pool: Pool;
  let repo: OrderExpiryRepository;
  let orgId: number;
  let eventId: string;
  let tierId: string;
  let seq = 0;
  const now = new Date();
  const lapsed = new Date(now.getTime() - HOUR);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup(pool);
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, locale) VALUES ('Oexp', $1, 'en') RETURNING id`,
      [ORG_SLUG],
    );
    orgId = Number(org.rows[0].id);
    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organization_id, slug, name, type, bucket, status, visibility,
                           start_at, timezone, organizer_name, published_at, requires_approval)
       VALUES ($1, $2, 'Oexp Summit', 'Conference', 'active', 'upcoming', 'public',
               now() + interval '30 days', 'Asia/Bangkok', 'Oexp', now(), true)
       RETURNING id`,
      [orgId, `${ORG_SLUG}-summit`],
    );
    eventId = event.rows[0].id;
    const tier = await pool.query<{ id: string }>(
      `INSERT INTO ticket_types (organization_id, event_id, name, price_satang,
                                 status, total, sold, min_per_order, max_per_order)
       VALUES ($1, $2, 'General', $3, 'onsale', 10, 0, 1, 8) RETURNING id`,
      [orgId, eventId, PRICE],
    );
    tierId = tier.rows[0].id;

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [OrderExpiryRepository],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    repo = app.get(OrderExpiryRepository);
  }, 30000);

  afterEach(async () => {
    await pool.query(`DELETE FROM seat_holds WHERE organization_id = $1`, [
      orgId,
    ]);
    await pool.query(`DELETE FROM orders WHERE organization_id = $1`, [orgId]);
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
    await app.close();
  });

  /** An order holding one place whose hold ran out an hour ago. */
  async function orderWithLapsedHold(o: {
    paymentStatus: 'pending' | 'paid';
    totalSatang: number;
    approvalRequestedAt: Date | null;
  }): Promise<{ orderId: string; holdId: string }> {
    seq += 1;
    const order = await pool.query<{ id: string }>(
      `INSERT INTO orders (organization_id, reference, event_id, buyer_name, buyer_email,
                           status, payment_status, seats, subtotal_satang, vat_amount_satang,
                           total_satang, requires_approval, approval_requested_at)
       VALUES ($1, $2, $3, 'Anan', $4, 'pending', $5, 1, $6, 0, $6, $7, $8)
       RETURNING id`,
      [
        orgId,
        `OEXP-${RUN}-${seq}`,
        eventId,
        `p${seq}@oexp.test`,
        o.paymentStatus,
        o.totalSatang,
        o.approvalRequestedAt !== null,
        o.approvalRequestedAt,
      ],
    );
    const orderId = order.rows[0].id;
    const hold = await pool.query<{ id: string }>(
      `INSERT INTO seat_holds (organization_id, event_id, order_id, ticket_type_id,
                               quantity, status, expires_at)
       VALUES ($1, $2, $3, $4, 1, 'active', $5) RETURNING id`,
      [orgId, eventId, orderId, tierId, lapsed],
    );
    return { orderId, holdId: hold.rows[0].id };
  }

  const sweep = () =>
    repo.expireLapsed({
      now,
      graceMs: 0,
      limit: SWEEP_LIMIT,
      waitlist: { offerMs: DAY, publicWebUrl: null },
    });

  const statusOf = async (orderId: string): Promise<string> =>
    (
      await pool.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [orderId],
      )
    ).rows[0].status;

  const holdStatusOf = async (holdId: string): Promise<string> =>
    (
      await pool.query<{ status: string }>(
        `SELECT status FROM seat_holds WHERE id = $1`,
        [holdId],
      )
    ).rows[0].status;

  it('expires a checkout whose hold lapsed before the money came', async () => {
    const unpaid = await orderWithLapsedHold({
      paymentStatus: 'pending',
      totalSatang: PRICE,
      approvalRequestedAt: null,
    });

    const result = await sweep();

    expect(await statusOf(unpaid.orderId)).toBe('expired');
    expect(await holdStatusOf(unpaid.holdId)).toBe('expired');
    expect(
      result.closed.filter((c) => c.organizationId === orgId).map((c) => c.id),
    ).toEqual([unpaid.orderId]);
  });

  it('leaves a free registration awaiting approval alone — it owes nothing', async () => {
    // Its hold is lapsed here on purpose: whatever its holds say, a
    // registration waiting for the organizer is not the sweep's to close.
    const waiting = await orderWithLapsedHold({
      paymentStatus: 'pending',
      totalSatang: 0,
      approvalRequestedAt: new Date(now.getTime() - DAY),
    });

    const result = await sweep();

    expect(await statusOf(waiting.orderId)).toBe('pending');
    expect(await holdStatusOf(waiting.holdId)).toBe('active');
    expect(result.closed.map((c) => c.id)).not.toContain(waiting.orderId);
  });

  it('leaves a paid registration awaiting approval alone — it has paid', async () => {
    const waiting = await orderWithLapsedHold({
      paymentStatus: 'paid',
      totalSatang: PRICE,
      approvalRequestedAt: new Date(now.getTime() - DAY),
    });

    await sweep();

    expect(await statusOf(waiting.orderId)).toBe('pending');
    expect(await holdStatusOf(waiting.holdId)).toBe('active');
  });
});

async function cleanup(pool: Pool): Promise<void> {
  const orgs = `SELECT id FROM organizations WHERE slug LIKE 'oexp-%'`;
  for (const table of [
    'outbox_events',
    'seat_holds',
    'orders',
    'ticket_types',
    'events',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE organization_id IN (${orgs})`);
  }
  await pool.query(`DELETE FROM organizations WHERE slug LIKE 'oexp-%'`);
}
