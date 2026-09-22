process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/db/database.module';
import { ReceiptsRepository } from '../src/modules/payments/receipts.repository';

const RUN = Date.now();
const ORG_SLUG = `receipt-${RUN}`;
const BAHT = 100;

/**
 * What the payment receipt reads, against the real schema (US-SET-10).
 *
 * The sender's spec mocks this repository wholesale, so this is the only place
 * the SQL runs. A receipt is a statement about money — a dropped status filter
 * here would email somebody a receipt for a payment that never went through.
 */
describe('ReceiptsRepository (e2e — US-SET-10)', () => {
  let app: INestApplication;
  let pool: Pool;
  let repo: ReceiptsRepository;
  let orgId: number;
  let eventId: string;
  let tierId: string;
  let seq = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup(pool);
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, locale, address, tax_id, vat_rate)
       VALUES ('Siam Events Co., Ltd.', $1, 'en', '99 Rama IV Rd, Bangkok', '0105556000001', 0.07)
       RETURNING id`,
      [ORG_SLUG],
    );
    orgId = Number(org.rows[0].id);
    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organization_id, slug, name, type, bucket, status, visibility,
                           start_at, timezone, organizer_name, published_at)
       VALUES ($1, $2, 'Receipt Summit', 'Conference', 'active', 'upcoming', 'public',
               now() + interval '30 days', 'Asia/Bangkok', 'Siam Events', now())
       RETURNING id`,
      [orgId, `${ORG_SLUG}-summit`],
    );
    eventId = event.rows[0].id;
    const tier = await pool.query<{ id: string }>(
      `INSERT INTO ticket_types (organization_id, event_id, name, price_satang,
                                 status, total, sold, min_per_order, max_per_order)
       VALUES ($1, $2, 'General', 89000, 'onsale', 100, 0, 1, 8) RETURNING id`,
      [orgId, eventId],
    );
    tierId = tier.rows[0].id;

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [ReceiptsRepository],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    repo = app.get(ReceiptsRepository);
  }, 30000);

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
    await app.close();
  });

  /** Two General at ฿890, ฿100 off, ฿84 fee → ฿1,764 with ฿115.40 VAT in it. */
  async function order(): Promise<string> {
    seq += 1;
    const res = await pool.query<{ id: string }>(
      `INSERT INTO orders (organization_id, reference, event_id, buyer_name, buyer_email,
                           status, payment_status, seats, subtotal_satang,
                           discount_amount_satang, vat_amount_satang, total_satang)
       VALUES ($1, $2, $3, 'Anan', 'anan@receipt.test', 'confirmed', 'paid', 2,
               178000, 10000, 11540, 176400)
       RETURNING id`,
      [orgId, `RCPT-${RUN}-${seq}`, eventId],
    );
    const id = res.rows[0].id;
    await pool.query(
      `INSERT INTO order_items (organization_id, order_id, ticket_type_id, quantity,
                                unit_price_satang, line_subtotal_satang)
       VALUES ($1, $2, $3, 2, 89000, 178000)`,
      [orgId, id, tierId],
    );
    return id;
  }

  async function payment(
    orderId: string,
    o: { status: string; method?: string; paidAt?: string | null },
  ): Promise<void> {
    seq += 1;
    await pool.query(
      `INSERT INTO payments (organization_id, txn, order_id, event_id, payer_name, method,
                             amount_satang, status, paid_at, idempotency_key)
       VALUES ($1, $2, $3, $4, 'Anan', $5::payment_method, 176400,
               $6::payment_status, $7, $8)`,
      [
        orgId,
        `TXN-${RUN}-${seq}`,
        orderId,
        eventId,
        o.method ?? 'Card',
        o.status,
        o.paidAt === undefined ? new Date() : o.paidAt,
        `idem-${RUN}-${seq}`,
      ],
    );
  }

  describe('loadReceipt', () => {
    it('reads the order’s lines and money exactly as checkout recorded them', async () => {
      const id = await order();
      await payment(id, { status: 'paid' });
      const receipt = await repo.loadReceipt(orgId, id);
      expect(receipt).toMatchObject({
        number: `RCPT-${RUN}-${seq - 1}`,
        buyerName: 'Anan',
        eventName: 'Receipt Summit',
        method: 'Card',
        subtotalSatang: 1_780 * BAHT,
        discountSatang: 100 * BAHT,
        vatSatang: 11_540,
        totalSatang: 1_764 * BAHT,
        currency: 'THB',
        vatRate: 0.07,
        lines: [
          {
            name: 'General',
            quantity: 2,
            unitSatang: 890 * BAHT,
            lineSatang: 1_780 * BAHT,
          },
        ],
      });
      expect(receipt?.paidAt).toBeInstanceOf(Date);
    });

    it('prints the organizer as the seller, with their tax ID', async () => {
      const id = await order();
      await payment(id, { status: 'paid' });
      expect((await repo.loadReceipt(orgId, id))?.seller).toEqual({
        name: 'Siam Events Co., Ltd.',
        address: '99 Rama IV Rd, Bangkok',
        taxId: '0105556000001',
      });
    });

    it('is null while the payment has not gone through', async () => {
      const id = await order();
      await payment(id, { status: 'pending', paidAt: null });
      await expect(repo.loadReceipt(orgId, id)).resolves.toBeNull();
    });

    it('is null for a payment that was given back', async () => {
      // Refunded before the email went: a receipt now would be for money the
      // attendee no longer paid.
      const id = await order();
      await payment(id, { status: 'refunded' });
      await expect(repo.loadReceipt(orgId, id)).resolves.toBeNull();
    });

    it('is for the payment that settled the order when a second one arrived', async () => {
      // A duplicate payment is refunded on its own path; the receipt belongs
      // to the first, and naming the second's method would misstate it.
      const id = await order();
      await payment(id, {
        status: 'paid',
        method: 'PromptPay',
        paidAt: '2026-08-01T03:00:00Z',
      });
      await payment(id, {
        status: 'paid',
        method: 'Card',
        paidAt: '2026-08-01T03:05:00Z',
      });
      const receipt = await repo.loadReceipt(orgId, id);
      expect(receipt?.method).toBe('PromptPay');
    });

    it('is null for another workspace’s order', async () => {
      const id = await order();
      await payment(id, { status: 'paid' });
      await expect(repo.loadReceipt(orgId + 1, id)).resolves.toBeNull();
      await expect(repo.loadReceipt(orgId, randomUUID())).resolves.toBeNull();
    });
  });

  describe('emailReceiptsOn', () => {
    it('is on for a workspace that never opened its payment settings', async () => {
      await expect(repo.emailReceiptsOn(orgId)).resolves.toBe(true);
    });

    it('is off once the admin turns “email receipts” off', async () => {
      await pool.query(
        `INSERT INTO payment_settings (organization_id, email_receipts) VALUES ($1, false)`,
        [orgId],
      );
      await expect(repo.emailReceiptsOn(orgId)).resolves.toBe(false);
    });
  });
});

async function cleanup(pool: Pool): Promise<void> {
  // payments and orders restrict their parent's deletion, so they go first.
  const orgs = `SELECT id FROM organizations WHERE slug LIKE 'receipt-%'`;
  await pool.query(`DELETE FROM payments WHERE organization_id IN (${orgs})`);
  await pool.query(`DELETE FROM orders WHERE organization_id IN (${orgs})`);
  await pool.query(`DELETE FROM organizations WHERE slug LIKE 'receipt-%'`);
}
