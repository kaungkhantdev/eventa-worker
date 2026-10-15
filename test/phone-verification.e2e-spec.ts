// Integration test against the shared docker infra (Postgres + RabbitMQ + Redis).
// Requires eventa-api's docker-compose up AND its migrations applied (users).
// Uses an isolated exchange/queue so it never touches the dev topology, and
// overrides the SmsProvider with a capturing fake to assert what was texted.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';
process.env.RABBITMQ_URL ??= 'amqp://eventa:eventa@localhost:5672';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.RABBITMQ_EXCHANGE = 'eventa.events.phone.test';
process.env.RABBITMQ_QUEUE = 'eventa.worker.phone.test';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { type SmsMessage, SmsProvider } from '../src/common/sms/sms.provider';
import { IDENTITY_PHONE_VERIFICATION_REQUESTED } from '../src/modules/users/phone-verification.schema';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection['createChannel']>>;

const EXCHANGE = 'eventa.events.phone.test';
const RUN = Date.now();
const MEMBER = `member-${RUN}@phone-it.test`;
const PHONE = '+66812345678';
const CODE = '042917';

/** In-memory SmsProvider: an enabled transport that keeps what it was given. */
class CapturingSmsProvider extends SmsProvider {
  readonly enabled = true;
  readonly sent: SmsMessage[] = [];
  send(message: SmsMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/**
 * "Given I change my phone, when I save, then I must confirm it by code before
 * it's used for texts" (US-DISC-11 AC3).
 *
 * eventa-api holds the new number aside and puts the code on
 * `identity.phone_verification_requested`. This proves the worker is bound to
 * that key and actually texts the code — to the requested number, in the
 * member's own language — and only once per message.
 */
describe('PhoneVerification consumer (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let conn: Connection;
  let channel: Channel;
  let orgId: number;
  let userId: string;
  const sms = new CapturingSmsProvider();
  const messageId = `phone-${RUN}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    redis = new Redis(process.env.REDIS_URL as string);
    await cleanup(pool);

    // A Thai-speaking attendee, in the PLATFORM org where every attendee lives.
    const user = await pool.query<{ id: string; organization_id: string }>(
      `INSERT INTO users (organization_id, name, email, persona, status, locale)
       SELECT id, 'Malee', $1, 'attendee', 'Active', 'th'
       FROM organizations WHERE slug = 'eventa'
       RETURNING id, organization_id`,
      [MEMBER],
    );
    userId = user.rows[0].id;
    orgId = Number(user.rows[0].organization_id);
    await redis.del(`evt:${messageId}`);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SmsProvider)
      .useValue(sms)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init(); // ConsumerService binds every handler's key + consumes

    conn = await amqp.connect(process.env.RABBITMQ_URL as string);
    channel = await conn.createChannel();
  }, 30000);

  afterAll(async () => {
    await channel?.close().catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await app?.close();
    await cleanup(pool);
    await redis.del(`evt:${messageId}`);
    await redis.quit();
    await pool.end();
  });

  /** Exactly the payload eventa-api's `phone-verification-requested.event.ts` builds. */
  const publish = (): void => {
    const payload = {
      version: 1,
      organizationId: orgId,
      userId,
      name: 'Malee',
      phone: PHONE,
      code: CODE,
      expiresAt: '2026-10-15T07:05:00.000Z',
      occurredAt: '2026-10-15T06:55:00.000Z',
    };
    channel.publish(
      EXCHANGE,
      IDENTITY_PHONE_VERIFICATION_REQUESTED,
      Buffer.from(JSON.stringify(payload)),
      {
        messageId,
        correlationId: 'cid-phone',
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

  it('texts the code to the requested number, in the member’s language', async () => {
    publish();
    await waitFor(() => sms.sent.length === 1);

    expect(sms.sent[0].to).toBe(PHONE);
    expect(sms.sent[0].text).toContain(CODE);
    expect(sms.sent[0].text).toContain('14:05');
    expect(sms.sent[0].text).toContain('รหัส');
  }, 15000);

  it('is idempotent on redelivery of the same messageId', async () => {
    publish();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(sms.sent).toHaveLength(1);
  }, 15000);
});

async function cleanup(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM users WHERE email LIKE '%@phone-it.test'`);
}
