process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/db/database.module';
import { MessageTemplatesRepository } from '../src/common/messaging/message-templates.repository';
import { RegistrationRepository } from '../src/modules/registration/registration.repository';

const RUN = Date.now();
const ORG_SLUG = `regconf-${RUN}`;
const BUYER = `buyer-${RUN}@regconf.test`;

/**
 * The DB half of US-MSG-01 against the real schema. The handler spec mocks this
 * repository wholesale, so without this nothing ever executes the SQL — a wrong
 * column name or a dropped status filter would surface only in production, as a
 * silently empty ticket list.
 */
describe('RegistrationRepository (e2e — US-MSG-01)', () => {
  let app: INestApplication;
  let pool: Pool;
  let repo: RegistrationRepository;
  let templates: MessageTemplatesRepository;
  let orgId: number;
  let eventId: string;
  let orderId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup(pool);
    ({ orgId, eventId, orderId } = await seed(pool));

    // Deliberately NOT AppModule: booting it starts the RabbitMQ consumer,
    // which would chew unrelated messages while this test runs. The repository
    // needs only config + the database.
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [RegistrationRepository, MessageTemplatesRepository],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    repo = app.get(RegistrationRepository);
    templates = app.get(MessageTemplatesRepository);
  }, 30000);

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
    await app.close();
  });

  describe('the kill switch every automated message checks', () => {
    it('is ON for a workspace that has never opened its settings', async () => {
      // No row is seeded on workspace creation, so absent MUST mean active —
      // otherwise every new workspace silently stops confirming registrations.
      await expect(
        templates.isActive(orgId, 'registration-confirmation'),
      ).resolves.toBe(true);
    });

    it('is OFF once the organizer turns it off', async () => {
      await pool.query(
        `INSERT INTO message_templates (organization_id, slug, title, active)
         VALUES ($1, 'registration-confirmation', 'Confirmation', false)`,
        [orgId],
      );
      await expect(
        templates.isActive(orgId, 'registration-confirmation'),
      ).resolves.toBe(false);
      await pool.query(
        `UPDATE message_templates SET active = true WHERE organization_id = $1`,
        [orgId],
      );
    });

    it('is unaffected by another workspace’s switch', async () => {
      const other = await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, slug) VALUES ('Other', $1) RETURNING id`,
        [`${ORG_SLUG}-other`],
      );
      const otherId = Number(other.rows[0].id);
      await pool.query(
        `INSERT INTO message_templates (organization_id, slug, title, active)
         VALUES ($1, 'registration-confirmation', 'Confirmation', false)`,
        [otherId],
      );
      await expect(
        templates.isActive(orgId, 'registration-confirmation'),
      ).resolves.toBe(true);
    });

    it('answers per message, not per workspace', async () => {
      // Two handlers read this now. A where-clause that forgot the slug would
      // let switching off the cancellation notice silence confirmations too.
      await pool.query(
        `INSERT INTO message_templates (organization_id, slug, title, active)
         VALUES ($1, 'cancellation-notice', 'Cancellation notice', false)`,
        [orgId],
      );
      await expect(
        templates.isActive(orgId, 'cancellation-notice'),
      ).resolves.toBe(false);
      await expect(
        templates.isActive(orgId, 'registration-confirmation'),
      ).resolves.toBe(true);
    });
  });

  describe('loadConfirmation', () => {
    it('returns only the tickets that still admit someone', async () => {
      const source = await repo.loadConfirmation(
        orgId,
        orderId,
        eventId,
        BUYER,
      );
      expect(source).not.toBeNull();
      // Seeded: one issued, one void, one soft-deleted — only the first counts.
      expect(source?.tickets).toHaveLength(1);
      expect(source?.tickets[0].ticketLabel).toBe('General');
    });

    it('reads the event the email prints', async () => {
      const source = await repo.loadConfirmation(
        orgId,
        orderId,
        eventId,
        BUYER,
      );
      expect(source?.event.name).toBe('Regconf Summit');
      expect(source?.event.timezone).toBe('Asia/Bangkok');
    });

    it('falls back to the workspace language when nothing else is set', async () => {
      const source = await repo.loadConfirmation(
        orgId,
        orderId,
        eventId,
        BUYER,
      );
      expect(source?.userLocale).toBeNull();
      expect(source?.orgLocale).toBe('en');
    });

    it('reads the event’s own language when it has one', async () => {
      await pool.query(`UPDATE events SET locale = 'th' WHERE id = $1`, [
        eventId,
      ]);
      const source = await repo.loadConfirmation(
        orgId,
        orderId,
        eventId,
        BUYER,
      );
      expect(source?.event.locale).toBe('th');
      await pool.query(`UPDATE events SET locale = NULL WHERE id = $1`, [
        eventId,
      ]);
    });

    it('finds the buyer’s own language in the PLATFORM org, not the organizer’s', async () => {
      // Attendee accounts live in the platform workspace so one person's
      // tickets can span organizers — looking in the organizer's org finds
      // nothing, and ignoring persona would match their staff row instead.
      await pool.query(
        `INSERT INTO users (organization_id, name, email, persona, status, locale)
         SELECT id, 'Buyer', $1, 'attendee', 'Active', 'th'
         FROM organizations WHERE slug = 'eventa'`,
        [BUYER],
      );
      const source = await repo.loadConfirmation(
        orgId,
        orderId,
        eventId,
        BUYER,
      );
      expect(source?.userLocale).toBe('th');
    });

    it('is null for an event that is not this workspace’s', async () => {
      await expect(
        repo.loadConfirmation(orgId, orderId, randomUUID(), BUYER),
      ).resolves.toBeNull();
    });
  });
});

async function seed(pool: Pool) {
  const org = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, locale) VALUES ('Regconf', $1, 'en') RETURNING id`,
    [ORG_SLUG],
  );
  const orgId = Number(org.rows[0].id);
  const event = await pool.query<{ id: string }>(
    `INSERT INTO events (organization_id, slug, name, type, bucket, status, visibility,
                         start_at, timezone, organizer_name, published_at)
     VALUES ($1, $2, 'Regconf Summit', 'Conference', 'active', 'upcoming', 'public',
             now() + interval '30 days', 'Asia/Bangkok', 'Regconf', now())
     RETURNING id`,
    [orgId, `${ORG_SLUG}-summit`],
  );
  const eventId = event.rows[0].id;
  const tier = await pool.query<{ id: string }>(
    `INSERT INTO ticket_types (organization_id, event_id, name, price_satang,
                               status, total, sold, min_per_order, max_per_order)
     VALUES ($1, $2, 'General', 100000, 'onsale', 100, 0, 1, 8) RETURNING id`,
    [orgId, eventId],
  );
  const order = await pool.query<{ id: string }>(
    `INSERT INTO orders (organization_id, reference, event_id, buyer_name, buyer_email,
                         status, payment_status, seats, subtotal_satang, vat_amount_satang, total_satang)
     VALUES ($1, $2, $3, 'Buyer', $4, 'confirmed', 'paid', 1, 100000, 6542, 100000)
     RETURNING id`,
    [orgId, `REGCONF-${RUN}`, eventId, BUYER],
  );
  const orderId = order.rows[0].id;
  const item = await pool.query<{ id: string }>(
    `INSERT INTO order_items (organization_id, order_id, ticket_type_id, quantity,
                              unit_price_satang, line_subtotal_satang)
     VALUES ($1, $2, $3, 3, 100000, 300000) RETURNING id`,
    [orgId, orderId, tier.rows[0].id],
  );
  // One live, one void, one soft-deleted — only the live one may be emailed.
  const rows: [string, string, boolean][] = [
    ['live', 'issued', false],
    ['void', 'void', false],
    ['gone', 'issued', true],
  ];
  for (const [suffix, status, deleted] of rows) {
    await pool.query(
      `INSERT INTO tickets (organization_id, order_id, order_item_id, event_id,
                            ticket_type_id, qr_token, holder_name, ticket_label,
                            status, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,'Buyer','General',$7::issued_ticket_status,
               CASE WHEN $8 THEN now() ELSE NULL END)`,
      [
        orgId,
        orderId,
        item.rows[0].id,
        eventId,
        tier.rows[0].id,
        `QR-${RUN}-${suffix}`,
        status,
        deleted,
      ],
    );
  }
  return { orgId, eventId, orderId };
}

async function cleanup(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM users WHERE email LIKE '%@regconf.test'`);
  await pool.query(`DELETE FROM organizations WHERE slug LIKE 'regconf-%'`);
}
