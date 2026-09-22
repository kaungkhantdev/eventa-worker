process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/db/database.module';
import { OrderExpiryRepository } from '../src/modules/order-expiry/order-expiry.repository';

const RUN = Date.now();
const ORG_SLUG = `wlq-${RUN}`;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const WEB = 'https://web.test';

/**
 * A lapsed waitlist offer, against the real schema (US-REG-04): "the seat
 * passes to the next person in line automatically and the attendee is told
 * their offer expired".
 *
 * This is hand-written, row-locked SQL that HANDS OUT SEATS, so it is proved
 * here rather than trusted — an off-by-one in what is free oversells a sold-out
 * event, and a wrong ORDER BY gives somebody's place to the person behind them.
 */
describe('Passing a lapsed waitlist offer on (e2e — US-REG-04)', () => {
  let app: INestApplication;
  let pool: Pool;
  let repo: OrderExpiryRepository;
  let orgId: number;
  let eventId: string;
  let seq = 0;
  const now = new Date();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup(pool);
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, locale) VALUES ('Wlq', $1, 'en') RETURNING id`,
      [ORG_SLUG],
    );
    orgId = Number(org.rows[0].id);
    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organization_id, slug, name, type, bucket, status, visibility,
                           start_at, timezone, organizer_name, published_at, waitlist_enabled)
       VALUES ($1, $2, 'Wlq Summit', 'Conference', 'active', 'upcoming', 'public',
               now() + interval '30 days', 'Asia/Bangkok', 'Wlq', now(), true)
       RETURNING id`,
      [orgId, `${ORG_SLUG}-summit`],
    );
    eventId = event.rows[0].id;

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [OrderExpiryRepository],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    repo = app.get(OrderExpiryRepository);
  }, 30000);

  afterEach(async () => {
    await pool.query(`DELETE FROM outbox_events WHERE organization_id = $1`, [
      orgId,
    ]);
    await pool.query(`DELETE FROM seat_holds WHERE organization_id = $1`, [
      orgId,
    ]);
    await pool.query(`DELETE FROM orders WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM ticket_types WHERE organization_id = $1`, [
      orgId,
    ]);
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
    await app.close();
  });

  /** A ticket with `total` places, every one of them sold or held. */
  async function tier(total: number): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO ticket_types (organization_id, event_id, name, price_satang,
                                 status, total, sold, min_per_order, max_per_order)
       VALUES ($1, $2, 'General', 100000, 'onsale', $3, 0, 1, 8) RETURNING id`,
      [orgId, eventId, total],
    );
    return res.rows[0].id;
  }

  async function order(
    tierId: string,
    o: { status: string; seats: number; joinedMinutesAgo: number },
  ): Promise<{ id: string; reference: string }> {
    seq += 1;
    const reference = `WLQ-${RUN}-${seq}`;
    const res = await pool.query<{ id: string }>(
      `INSERT INTO orders (organization_id, reference, event_id, buyer_name, buyer_email,
                           status, payment_status, seats, subtotal_satang, vat_amount_satang,
                           total_satang, registered_at)
       VALUES ($1, $2, $3, $4, $5, $6::order_status, 'pending', $7, $8, 0, $8,
               now() - make_interval(mins => $9))
       RETURNING id`,
      [
        orgId,
        reference,
        eventId,
        `Person ${seq}`,
        `p${seq}@wlq.test`,
        o.status,
        o.seats,
        o.seats * 100000,
        o.joinedMinutesAgo,
      ],
    );
    const id = res.rows[0].id;
    await pool.query(
      `INSERT INTO order_items (organization_id, order_id, ticket_type_id, quantity,
                                unit_price_satang, line_subtotal_satang)
       VALUES ($1, $2, $3, $4, 100000, $5)`,
      [orgId, id, tierId, o.seats, o.seats * 100000],
    );
    return { id, reference };
  }

  /** An offer whose deadline has passed, still holding its seats. */
  async function lapsedOffer(tierId: string, seats: number) {
    const offer = await order(tierId, {
      status: 'pending',
      seats,
      joinedMinutesAgo: 600,
    });
    const past = new Date(now.getTime() - 10 * MINUTE);
    await pool.query(
      `UPDATE orders SET offered_at = $2, offer_expires_at = $3 WHERE id = $1`,
      [offer.id, new Date(past.getTime() - DAY), past],
    );
    await hold(tierId, offer.id, seats, past);
    return offer;
  }

  async function hold(
    tierId: string,
    orderId: string,
    quantity: number,
    expiresAt: Date,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO seat_holds (organization_id, event_id, order_id, ticket_type_id,
                               quantity, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
      [orgId, eventId, orderId, tierId, quantity, expiresAt],
    );
  }

  const sweep = (publicWebUrl: string | null = WEB) =>
    repo.expireLapsed({
      now,
      graceMs: 0,
      limit: 50,
      waitlist: { offerMs: DAY, publicWebUrl },
    });

  const orderRow = async (id: string) =>
    (
      await pool.query<{
        status: string;
        offered_by: string | null;
        offer_skipped: number | null;
        offer_expires_at: Date | null;
      }>(
        `SELECT status, offered_by, offer_skipped, offer_expires_at FROM orders WHERE id = $1`,
        [id],
      )
    ).rows[0];

  const outbox = async () =>
    (
      await pool.query<{
        routing_key: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT routing_key, aggregate_id, payload FROM outbox_events
         WHERE organization_id = $1 ORDER BY id`,
        [orgId],
      )
    ).rows;

  it('closes the lapsed offer, tells its owner, and offers the seats to the next in line', async () => {
    const tierId = await tier(2);
    const lapsed = await lapsedOffer(tierId, 2);
    const first = await order(tierId, {
      status: 'waitlisted',
      seats: 2,
      joinedMinutesAgo: 300,
    });
    const second = await order(tierId, {
      status: 'waitlisted',
      seats: 1,
      joinedMinutesAgo: 200,
    });

    const result = await sweep();

    expect(result.offered).toEqual([first.reference]);
    expect((await orderRow(lapsed.id)).status).toBe('expired');
    const offered = await orderRow(first.id);
    expect(offered.status).toBe('pending');
    // The line chose them, not a person — and nobody was passed over.
    expect(offered.offered_by).toBeNull();
    expect(offered.offer_skipped).toBe(0);
    expect(offered.offer_expires_at?.getTime()).toBe(now.getTime() + DAY);
    // Both seats went to the first person; there is nothing for the second.
    expect((await orderRow(second.id)).status).toBe('waitlisted');

    const rows = await outbox();
    expect(rows.map((r) => [r.routing_key, r.aggregate_id])).toEqual([
      ['waitlist.offer_expired', lapsed.id],
      ['waitlist.offered', first.id],
    ]);
    expect(rows[1].payload.buyerEmail).toMatch(/@wlq\.test$/);
    expect(rows[1].payload).toMatchObject({
      ticketTypeName: 'General',
      ticketCount: 2,
      payUrl: `${WEB}/my/tickets/orders/${first.id}`,
    });
  });

  it('holds the seats for the person it offered them to', async () => {
    const tierId = await tier(2);
    await lapsedOffer(tierId, 2);
    const first = await order(tierId, {
      status: 'waitlisted',
      seats: 2,
      joinedMinutesAgo: 300,
    });
    await sweep();
    const holds = await pool.query<{ quantity: number; status: string }>(
      `SELECT quantity, status FROM seat_holds WHERE order_id = $1`,
      [first.id],
    );
    expect(holds.rows).toEqual([{ quantity: 2, status: 'active' }]);
  });

  it('offers to as many as now fit, strictly in the order they joined', async () => {
    const tierId = await tier(3);
    await lapsedOffer(tierId, 3);
    const first = await order(tierId, {
      status: 'waitlisted',
      seats: 1,
      joinedMinutesAgo: 300,
    });
    const second = await order(tierId, {
      status: 'waitlisted',
      seats: 2,
      joinedMinutesAgo: 200,
    });
    const third = await order(tierId, {
      status: 'waitlisted',
      seats: 1,
      joinedMinutesAgo: 100,
    });

    const result = await sweep();

    expect(result.offered).toEqual([first.reference, second.reference]);
    expect((await orderRow(third.id)).status).toBe('waitlisted');
  });

  it('never skips the front of the line for somebody who fits', async () => {
    // Two seats free; the first person wants three. Offering the second
    // person instead would be the out-of-order choice only an organizer may
    // make, on the record.
    const tierId = await tier(2);
    await lapsedOffer(tierId, 2);
    const first = await order(tierId, {
      status: 'waitlisted',
      seats: 3,
      joinedMinutesAgo: 300,
    });
    const second = await order(tierId, {
      status: 'waitlisted',
      seats: 1,
      joinedMinutesAgo: 200,
    });

    const result = await sweep();

    expect(result.offered).toEqual([]);
    expect((await orderRow(first.id)).status).toBe('waitlisted');
    expect((await orderRow(second.id)).status).toBe('waitlisted');
  });

  it('counts seats other people hold as taken', async () => {
    // One of the two freed seats is already held by a live checkout: only one
    // is free, and a two-seat request must wait.
    const tierId = await tier(3);
    await lapsedOffer(tierId, 2);
    const buyer = await order(tierId, {
      status: 'pending',
      seats: 1,
      joinedMinutesAgo: 1,
    });
    await hold(tierId, buyer.id, 1, new Date(now.getTime() + 10 * MINUTE));
    const first = await order(tierId, {
      status: 'waitlisted',
      seats: 3,
      joinedMinutesAgo: 300,
    });
    expect((await sweep()).offered).toEqual([]);
    expect((await orderRow(first.id)).status).toBe('waitlisted');
  });

  it('still closes the offer and tells its owner without a web address, but offers nobody', async () => {
    // No link can be written, so no offer can be made — but the lapsed one
    // is still over, and its owner still hears so.
    const tierId = await tier(2);
    const lapsed = await lapsedOffer(tierId, 2);
    const first = await order(tierId, {
      status: 'waitlisted',
      seats: 1,
      joinedMinutesAgo: 300,
    });

    const result = await sweep(null);

    expect(result).toMatchObject({ lapsedOffers: 1, offered: [] });
    expect((await orderRow(lapsed.id)).status).toBe('expired');
    expect((await orderRow(first.id)).status).toBe('waitlisted');
    expect((await outbox()).map((r) => r.routing_key)).toEqual([
      'waitlist.offer_expired',
    ]);
  });

  it('leaves the waitlist alone when an ordinary checkout lapses', async () => {
    // Only an OFFER passes on. A buyer abandoning checkout is not someone the
    // waitlist was promised anything by.
    const tierId = await tier(1);
    const abandoned = await order(tierId, {
      status: 'pending',
      seats: 1,
      joinedMinutesAgo: 30,
    });
    await hold(tierId, abandoned.id, 1, new Date(now.getTime() - 10 * MINUTE));
    const first = await order(tierId, {
      status: 'waitlisted',
      seats: 1,
      joinedMinutesAgo: 300,
    });

    const result = await sweep();

    expect(result).toMatchObject({ lapsedOffers: 0, offered: [] });
    expect((await orderRow(abandoned.id)).status).toBe('expired');
    expect((await orderRow(first.id)).status).toBe('waitlisted');
    expect(await outbox()).toEqual([]);
  });
});

async function cleanup(pool: Pool): Promise<void> {
  const orgs = `SELECT id FROM organizations WHERE slug LIKE 'wlq-%'`;
  await pool.query(
    `DELETE FROM outbox_events WHERE organization_id IN (${orgs})`,
  );
  await pool.query(`DELETE FROM seat_holds WHERE organization_id IN (${orgs})`);
  await pool.query(`DELETE FROM orders WHERE organization_id IN (${orgs})`);
  await pool.query(`DELETE FROM organizations WHERE slug LIKE 'wlq-%'`);
}
