// Integration test against the shared docker infra (Postgres + RabbitMQ + Redis).
// Requires eventa-api's docker-compose up AND its migrations applied (events +
// orders). Uses an isolated exchange/queue so it never touches the dev topology.
//
// Proves the fix for the claim-on-start idempotency gap: a fan-out broadcast whose
// first delivery is INTERRUPTED partway (here: the tail fails, so the handler dies
// without completing) must, on redelivery, mail ONLY the un-sent tail — never the
// already-notified head, and never skip-and-ack the un-done work. End result: every
// recipient is mailed exactly once across the interruption.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';
process.env.RABBITMQ_URL ??= 'amqp://eventa:eventa@localhost:5672';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.RABBITMQ_EXCHANGE = 'eventa.events.intr.test';
process.env.RABBITMQ_QUEUE = 'eventa.worker.intr.test';

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

const EXCHANGE = 'eventa.events.intr.test';
const SLUG = 'intr-it-org';

/**
 * Capturing EmailProvider whose `failFor` set can be flipped between deliveries to
 * simulate a mid-broadcast interruption (the failing sends model the recipients a
 * crashed run never reached).
 */
class CapturingEmailProvider extends EmailProvider {
  readonly sent: EmailMessage[] = [];
  failFor = new Set<string>();
  send(message: EmailMessage): Promise<void> {
    if (this.failFor.has(message.to)) {
      return Promise.reject(new Error('smtp 550 (simulated interruption)'));
    }
    this.sent.push(message);
    return Promise.resolve();
  }
}

describe('AttendeesEmail interruption recovery (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let conn: Connection;
  let channel: Channel;
  let orgId: number;
  let eventId: string;
  const email = new CapturingEmailProvider();
  const messageId = `intr-${Date.now()}`;

  const HEAD = ['anan@x.test', 'ben@x.test'];
  const TAIL = ['chai@x.test', 'dara@x.test'];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    redis = new Redis(process.env.REDIS_URL as string);
    await reset(pool);

    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ('Intr IT', $1) RETURNING id`,
      [SLUG],
    );
    orgId = Number(org.rows[0].id);
    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organization_id, slug, name, type, bucket, start_at, organizer_name, status)
       VALUES ($1, 'intr-evt', 'Intr Event', 'Conference', 'active', now(), 'Organizer', 'upcoming')
       RETURNING id`,
      [orgId],
    );
    eventId = event.rows[0].id;

    // Four confirmed attendees: a head (delivered before the interruption) and a
    // tail (never reached). Order by buyer_email is deterministic (a,b,c,d).
    await seedOrder('ref-a', 'anan@x.test', 'Anan');
    await seedOrder('ref-b', 'ben@x.test', 'Ben');
    await seedOrder('ref-c', 'chai@x.test', 'Chai');
    await seedOrder('ref-d', 'dara@x.test', 'Dara');

    await redis.del(`evt:${messageId}`);
    await redis.del(`evt:sent:${messageId}`);

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
    await redis.del(`evt:sent:${messageId}`);
    await redis.quit();
    await pool.end();
  });

  const seedOrder = (
    reference: string,
    buyerEmail: string,
    buyerName: string,
  ): Promise<unknown> =>
    pool.query(
      `INSERT INTO orders
         (organization_id, reference, event_id, buyer_name, buyer_email, seats, subtotal_satang, total_satang, status)
       VALUES ($1, $2, $3, $4, $5, 1, 10000, 10700, 'confirmed')`,
      [orgId, reference, eventId, buyerName, buyerEmail],
    );

  const publish = (): void => {
    const payload = {
      version: 1,
      organizationId: orgId,
      eventId,
      subject: 'Doors open at 9am',
      message: 'See you there — bring your QR code!',
      requestedByUserId: '00000000-0000-0000-0000-000000000000',
      recipientCount: 4,
      occurredAt: new Date().toISOString(),
    };
    channel.publish(
      EXCHANGE,
      EVENTS_ATTENDEES_EMAIL_REQUESTED,
      Buffer.from(JSON.stringify(payload)),
      { messageId, correlationId: 'cid-intr', contentType: 'application/json' },
    );
  };

  const recipientsSent = (): string[] => email.sent.map((m) => m.to).sort();

  const waitFor = async (
    predicate: () => boolean | Promise<boolean>,
    ms = 8000,
  ): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('condition not met within timeout');
  };

  it('mails only the head, then dead-letters, when the first delivery is interrupted', async () => {
    email.failFor = new Set(TAIL); // the tail sends fail → handler throws → nack→DLQ
    publish();

    await waitFor(() => email.sent.length === 2);
    expect(recipientsSent()).toEqual(HEAD);
    // The interrupted run did NOT record the message as completed.
    expect(await redis.exists(`evt:${messageId}`)).toBe(0);
  }, 15000);

  it('delivers only the un-sent tail — exactly once — on redelivery', async () => {
    email.failFor.clear(); // provider healthy again
    publish(); // same messageId → simulated broker redelivery / DLQ replay

    await waitFor(() => email.sent.length === 4);
    // Head was NOT re-mailed; every recipient appears exactly once.
    expect(recipientsSent()).toEqual([...HEAD, ...TAIL].sort());
    // Now recorded as completed.
    await waitFor(async () => (await redis.exists(`evt:${messageId}`)) === 1);
  }, 15000);

  it('is a no-op on any further redelivery of the completed message', async () => {
    publish(); // same messageId, now completed
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(email.sent.length).toBe(4);
  }, 15000);
});

async function reset(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
}
