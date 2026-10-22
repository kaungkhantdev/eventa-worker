// Integration test against the shared docker infra (Postgres + RabbitMQ + Redis).
// Requires eventa-api's docker-compose up AND its migrations applied (the
// platform organization). Uses an isolated exchange/queue so it never touches
// the dev topology, and overrides the EmailProvider with a capturing fake to
// assert what was mailed.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';
process.env.RABBITMQ_URL ??= 'amqp://eventa:eventa@localhost:5672';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.RABBITMQ_EXCHANGE = 'eventa.events.booking-claim.test';
process.env.RABBITMQ_QUEUE = 'eventa.worker.booking-claim.test';
import { randomUUID } from 'node:crypto';
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
import { IDENTITY_BOOKING_ACCOUNT_LINK_REQUESTED } from '../src/common/constants/auth-booking-signup.constants';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection['createChannel']>>;

const EXCHANGE = 'eventa.events.booking-claim.test';
const RUN = Date.now();
const BUYER = `buyer-${RUN}@booking-claim.test`;
const CLAIM_URL = `https://web.test/portal/register?claim=token-${RUN}`;

/** Captures every send so the test can say who was mailed, and with what. */
class CapturingEmailProvider extends EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/**
 * "Given I follow the link, when the sign-up page opens…" (US-DISC-15) — and
 * the link only ever reaches that page through the booking's own inbox.
 *
 * eventa-api signs the claim token and puts the link on
 * `identity.booking_account_link_requested`. This proves the worker is bound
 * to that key and mails the link, with its expiry, to the buyer's address —
 * once per message, however often the message is delivered.
 */
describe('BookingAccountLink consumer (integration)', () => {
  let app: INestApplication;
  let redis: Redis;
  let conn: Connection;
  let channel: Channel;
  let platformOrgId: number;
  const email = new CapturingEmailProvider();
  const messageId = `booking-claim-${RUN}`;

  beforeAll(async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const org = await pool.query<{ id: string }>(
      `SELECT id FROM organizations WHERE slug = 'eventa'`,
    );
    await pool.end();
    platformOrgId = Number(org.rows[0].id);

    redis = new Redis(process.env.REDIS_URL as string);
    await redis.del(`evt:${messageId}`);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailProvider)
      .useValue(email)
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
    await redis.del(`evt:${messageId}`);
    await redis.quit();
  });

  /** The payload eventa-api writes when a guest asks to keep their tickets. */
  const publish = (): void => {
    const payload = {
      version: 1,
      organizationId: platformOrgId,
      orderId: randomUUID(),
      name: 'Malee',
      email: BUYER,
      eventName: 'Bangkok Jazz Night',
      claimUrl: CLAIM_URL,
      expiresAt: '2026-10-22T07:05:00.000Z',
      locale: 'en',
      occurredAt: '2026-10-15T07:05:00.000Z',
    };
    channel.publish(
      EXCHANGE,
      IDENTITY_BOOKING_ACCOUNT_LINK_REQUESTED,
      Buffer.from(JSON.stringify(payload)),
      {
        messageId,
        correlationId: 'cid-booking-claim',
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

  it('mails the claim link, and when it expires, to the buyer', async () => {
    publish();
    await waitFor(() => email.sent.length === 1);

    expect(email.sent[0].to).toBe(BUYER);
    expect(email.sent[0].subject).toBe(
      'Keep your tickets for Bangkok Jazz Night in an Eventa account',
    );
    expect(email.sent[0].text).toContain(CLAIM_URL);
    // 07:05 UTC on the wire is 14:05 in Bangkok.
    expect(email.sent[0].text).toContain('22 October 2026 at 14:05');
    expect(email.sent[0].text).toContain('Bangkok time');
  }, 15000);

  it('is idempotent on redelivery of the same messageId', async () => {
    publish();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(email.sent).toHaveLength(1);
  }, 15000);
});
