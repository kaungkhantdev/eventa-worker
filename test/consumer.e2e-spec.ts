// Integration test against the shared docker infra (Postgres + RabbitMQ + Redis).
// Requires eventa-api's docker-compose up AND its migrations applied (audit_events
// + FKs). Uses an isolated exchange/queue so it never touches the dev topology.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';
process.env.RABBITMQ_URL ??= 'amqp://eventa:eventa@localhost:5672';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.RABBITMQ_EXCHANGE = 'eventa.events.test';
process.env.RABBITMQ_QUEUE = 'eventa.worker.test';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { IDENTITY_SIGNED_IN } from '../src/modules/identity/signed-in.schema';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection['createChannel']>>;

const EXCHANGE = 'eventa.events.test';
const SLUG = 'worker-it-org';

describe('SignedIn consumer (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let conn: Connection;
  let channel: Channel;
  let orgId: number;
  let userId: string;
  const messageId = `wit-${Date.now()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    redis = new Redis(process.env.REDIS_URL as string);

    await pool.query(
      `DELETE FROM audit_events WHERE organization_id IN (SELECT id FROM organizations WHERE slug=$1)`,
      [SLUG],
    );
    await pool.query(`DELETE FROM organizations WHERE slug=$1`, [SLUG]);
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ('Worker IT', $1) RETURNING id`,
      [SLUG],
    );
    orgId = Number(org.rows[0].id);
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email) VALUES ($1,'Bot','bot@worker-it.test') RETURNING id`,
      [orgId],
    );
    userId = user.rows[0].id;
    await redis.del(`evt:${messageId}`);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // ConsumerService bootstraps: asserts topology, binds, consumes

    conn = await amqp.connect(process.env.RABBITMQ_URL as string);
    channel = await conn.createChannel();
  }, 30000);

  afterAll(async () => {
    await channel.close().catch(() => undefined);
    await conn.close().catch(() => undefined);
    await app.close();
    await pool.query(`DELETE FROM audit_events WHERE organization_id = $1`, [
      orgId,
    ]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await redis.del(`evt:${messageId}`);
    await redis.quit();
    await pool.end();
  });

  const publish = (id: string): void => {
    const payload = {
      version: 1,
      organizationId: orgId,
      userId,
      device: 'Chrome on Mac',
      ip: '203.0.113.9',
      occurredAt: new Date().toISOString(),
    };
    channel.publish(
      EXCHANGE,
      IDENTITY_SIGNED_IN,
      Buffer.from(JSON.stringify(payload)),
      {
        messageId: id,
        correlationId: 'cid-it',
        contentType: 'application/json',
      },
    );
  };

  const countAudit = async (): Promise<number> => {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE organization_id=$1 AND type='signin'`,
      [orgId],
    );
    return r.rows[0].n;
  };

  const waitFor = async (
    predicate: () => Promise<boolean>,
    ms = 8000,
  ): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('condition not met within timeout');
  };

  it('consumes identity.signed_in and writes an audit row', async () => {
    publish(messageId);
    await waitFor(async () => (await countAudit()) === 1);
    expect(await countAudit()).toBe(1);
  }, 15000);

  it('is idempotent on redelivery of the same messageId', async () => {
    publish(messageId); // same id → deduped by Redis SET NX
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await countAudit()).toBe(1);
  }, 15000);
});
