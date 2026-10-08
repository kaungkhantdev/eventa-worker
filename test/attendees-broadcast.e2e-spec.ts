// Integration test against the shared docker infra (Postgres + RabbitMQ + Redis).
// Requires eventa-api's docker-compose up AND its migrations applied (events +
// orders). Uses an isolated exchange/queue so it never touches the dev topology,
// and overrides the EmailProvider with a capturing fake to assert who was mailed.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';
process.env.RABBITMQ_URL ??= 'amqp://eventa:eventa@localhost:5672';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.RABBITMQ_EXCHANGE = 'eventa.events.bcast.test';
process.env.RABBITMQ_QUEUE = 'eventa.worker.bcast.test';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import {
  type EmailMessage,
  EmailProvider,
} from '../src/common/email/email.provider';
import { EVENTS_ATTENDEES_EMAIL_REQUESTED } from '../src/modules/events/attendees-email.schema';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection['createChannel']>>;

const EXCHANGE = 'eventa.events.bcast.test';
const SLUG = 'bcast-it-org';

/** In-memory EmailProvider: captures every send so the test can assert recipients. */
class CapturingEmailProvider extends EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

describe('AttendeesEmail consumer (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let conn: Connection;
  let channel: Channel;
  let orgId: number;
  let eventId: string;
  const email = new CapturingEmailProvider();
  const messageId = `bcast-${Date.now()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    redis = new Redis(process.env.REDIS_URL as string);
    await reset(pool);

    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ('Bcast IT', $1) RETURNING id`,
      [SLUG],
    );
    orgId = Number(org.rows[0].id);
    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organization_id, slug, name, type, bucket, start_at, organizer_name, status)
       VALUES ($1, 'bcast-evt', 'Bcast Event', 'Conference', 'active', now(), 'Organizer', 'upcoming')
       RETURNING id`,
      [orgId],
    );
    eventId = event.rows[0].id;

    // Two distinct confirmed attendees (anan appears twice → must dedup to one),
    // plus a cancelled and a pending order that must be excluded.
    await seedOrder('ref-1', 'anan@x.test', 'Anan', 'confirmed');
    await seedOrder('ref-2', 'anan@x.test', 'Anan', 'confirmed');
    await seedOrder('ref-3', 'ben@x.test', 'Ben', 'confirmed');
    await seedOrder('ref-4', 'chai@x.test', 'Chai', 'cancelled');
    await seedOrder('ref-5', 'dara@x.test', 'Dara', 'pending');
    await redis.del(`evt:${messageId}`);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailProvider)
      .useValue(email)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init(); // ConsumerService binds events.* keys + consumes

    conn = await amqp.connect(process.env.RABBITMQ_URL as string);
    channel = await conn.createChannel();
  }, 30000);

  afterAll(async () => {
    await channel?.close().catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await app?.close();
    await reset(pool);
    await redis.del(`evt:${messageId}`);
    await redis.quit();
    await pool.end();
  });

  const seedOrder = (
    reference: string,
    buyerEmail: string,
    buyerName: string,
    status: string,
  ): Promise<unknown> =>
    pool.query(
      `INSERT INTO orders
         (organization_id, reference, event_id, buyer_name, buyer_email, seats, subtotal_satang, total_satang, status)
       VALUES ($1, $2, $3, $4, $5, 1, 10000, 10700, $6)`,
      [orgId, reference, eventId, buyerName, buyerEmail, status],
    );

  const publish = (): void => {
    const payload = {
      version: 1,
      organizationId: orgId,
      eventId,
      subject: 'Doors open at 9am',
      message: 'See you there — bring your QR code!',
      requestedByUserId: '00000000-0000-0000-0000-000000000000',
      recipientCount: 2,
      occurredAt: new Date().toISOString(),
    };
    channel.publish(
      EXCHANGE,
      EVENTS_ATTENDEES_EMAIL_REQUESTED,
      Buffer.from(JSON.stringify(payload)),
      {
        messageId,
        correlationId: 'cid-bcast',
        contentType: 'application/json',
      },
    );
  };

  const waitFor = async (
    predicate: () => boolean,
    ms = 8000,
  ): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('condition not met within timeout');
  };

  it('mails only the distinct confirmed attendees (excludes cancelled/pending, dedups)', async () => {
    publish();
    await waitFor(() => email.sent.length === 2);

    const recipients = email.sent.map((m) => m.to).sort();
    expect(recipients).toEqual(['anan@x.test', 'ben@x.test']);
    expect(email.sent[0].subject).toBe('Doors open at 9am');
    expect(email.sent[0].text).toContain('bring your QR code');
  }, 15000);

  it('is idempotent on redelivery of the same messageId', async () => {
    publish(); // same messageId → deduped by Redis SET NX
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(email.sent.length).toBe(2);
  }, 15000);
});

async function reset(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
}
