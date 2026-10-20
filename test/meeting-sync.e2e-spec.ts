// Integration test against the shared docker infra (Postgres + RabbitMQ + Redis).
// Requires eventa-api's docker-compose up AND its migrations applied through
// 0075 (calendar_connections). LOCAL ONLY — CI runs no e2e here.
//
// Runs with the FAKE calendar, so nothing reaches Google; uses an isolated
// exchange/queue (deleted afterwards) so it never touches the dev topology.
// Everything below is set BEFORE AppModule is imported: the env schema is
// evaluated when that import runs.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://eventa:eventa@localhost:5432/eventa';
process.env.RABBITMQ_URL ??= 'amqp://eventa:eventa@localhost:5672';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.RABBITMQ_EXCHANGE = 'eventa.events.meetings.test';
process.env.RABBITMQ_QUEUE = 'eventa.worker.meetings.test';
process.env.CALENDAR_PROVIDER = 'fake';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { SecretCipher } from '../src/common/crypto/secret-cipher';
import { MEETING_SYNC_REQUESTED } from '../src/common/constants/meetings.constants';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection['createChannel']>>;

const EXCHANGE = 'eventa.events.meetings.test';
const QUEUE = 'eventa.worker.meetings.test';
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
const RUN = Date.now();
const SLUG = `meeting-it-${RUN}`;
const GUEST = `guest-${RUN}@meeting-it.test`;

interface MeetingRow {
  sync_status: string;
  sync_error: string | null;
  link: string | null;
  external_event_id: string | null;
  updated_at: string;
  version: number;
}

/**
 * "Given Google Calendar is connected, when I schedule a meeting, then the
 * guest gets an invite and a video meeting gets a Meet link" (US-MTG-04 AC1),
 * and what the card says when it is not connected (US-MTG-08 AC2), when the
 * grant is revoked (AC3) and when Google is down (US-MTG-04 AC4).
 *
 * Proves what the unit specs cannot: the queue is bound to
 * `meeting.sync_requested`, the DI graph resolves, the worker decrypts a token
 * sealed the api's way, and the write-backs land against real Postgres — the
 * `updated_at` comparison (string mode, microseconds) and the bytea compare in
 * `markExpired` included.
 */
describe('Meeting calendar sync (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let conn: Connection;
  let channel: Channel;
  let cipher: SecretCipher;
  const messageIds: string[] = [];
  const orgs: Record<'connected' | 'none' | 'revoked', number> = {
    connected: 0,
    none: 0,
    revoked: 0,
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    redis = new Redis(process.env.REDIS_URL as string);
    await cleanup(pool);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // ConsumerService binds every handler's key + consumes
    cipher = app.get(SecretCipher, { strict: false });

    orgs.connected = await seedOrg(pool, 'connected');
    orgs.none = await seedOrg(pool, 'none');
    orgs.revoked = await seedOrg(pool, 'revoked');
    // Sealed by the worker's own cipher, which is byte-compatible with the
    // api's: what an Admin's connect leaves behind.
    await seedConnection(
      pool,
      orgs.connected,
      cipher.encrypt(`fake-refresh-${RUN}`),
    );
    // A token the fake refuses, as Google refuses a revoked one.
    await seedConnection(
      pool,
      orgs.revoked,
      cipher.encrypt(`1//revoked-${RUN}`),
    );

    conn = await amqp.connect(process.env.RABBITMQ_URL as string);
    channel = await conn.createChannel();
  }, 30000);

  afterAll(async () => {
    await tearDownTopology(channel);
    await channel?.close().catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await app?.close();
    await cleanup(pool);
    for (const id of messageIds) await redis.del(`evt:${id}`);
    await redis.quit();
    await pool.end();
  });

  /** Exactly the payload eventa-api's `meeting-sync.event.ts` builds (v1). */
  const publish = (organizationId: number, meetingId: string): void => {
    const messageId = `meeting-${RUN}-${messageIds.length}`;
    messageIds.push(messageId);
    const payload = {
      version: 1,
      organizationId,
      meetingId,
      intent: 'create',
      title: 'ignored — the row is the source of truth',
      startsAt: '2026-10-21T07:00:00.000Z',
      endsAt: '2026-10-21T08:00:00.000Z',
      guestEmail: GUEST,
      person: 'Somchai',
      mode: 'Video',
      needsLink: true,
      location: null,
      notes: null,
      externalEventId: null,
      cancellationReason: null,
      occurredAt: new Date().toISOString(),
    };
    channel.publish(
      EXCHANGE,
      MEETING_SYNC_REQUESTED,
      Buffer.from(JSON.stringify(payload)),
      {
        messageId,
        correlationId: 'cid-meeting',
        contentType: 'application/json',
      },
    );
  };

  const meetingRow = async (id: string): Promise<MeetingRow> =>
    (
      await pool.query<MeetingRow>(
        `SELECT sync_status, sync_error, link, external_event_id,
                updated_at::text AS updated_at, version
           FROM meetings WHERE id = $1`,
        [id],
      )
    ).rows[0];

  const waitForStatus = async (
    id: string,
    status: string,
    ms = 8000,
  ): Promise<MeetingRow> => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const row = await meetingRow(id);
      if (row.sync_status === status) return row;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`meeting never reached ${status}`);
  };

  it('sends the invite with a Meet link, and records the deterministic event id', async () => {
    const id = await seedMeeting(pool, orgs.connected, 'Venue walkthrough');
    const before = await meetingRow(id);

    publish(orgs.connected, id);
    const after = await waitForStatus(id, 'synced');

    expect(after.link).toMatch(
      /^https:\/\/meet\.google\.com\/[a-p]{3}-[a-p]{4}-[a-p]{3}$/,
    );
    expect(after.external_event_id).toBe(id.replace(/-/g, ''));
    expect(after.sync_error).toBeNull();
    // The organizer's change token and version are never the worker's to move.
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.version).toBe(before.version);
  }, 15000);

  it('does nothing more on a second delivery for a synced meeting', async () => {
    const id = await seedMeeting(pool, orgs.connected, 'Sponsor call');
    publish(orgs.connected, id);
    const first = await waitForStatus(id, 'synced');

    publish(orgs.connected, id);
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(await meetingRow(id)).toEqual(first);
  }, 15000);

  it('marks the meeting not connected when the workspace never connected (US-MTG-08 AC2)', async () => {
    const id = await seedMeeting(pool, orgs.none, 'Speaker briefing');

    publish(orgs.none, id);
    const row = await waitForStatus(id, 'not_connected');

    expect(row.sync_error).toBeNull();
    expect(row.link).toBeNull();
  }, 15000);

  it('marks the connection expired when the grant is refused (US-MTG-08 AC3)', async () => {
    const id = await seedMeeting(pool, orgs.revoked, 'Vendor check-in');

    publish(orgs.revoked, id);
    const row = await waitForStatus(id, 'not_connected');

    expect(row.sync_error).toBe('The Google Calendar connection has expired.');
    const connection = await pool.query<{ status: string }>(
      `SELECT status FROM calendar_connections WHERE organization_id = $1`,
      [orgs.revoked],
    );
    expect(connection.rows[0].status).toBe('expired');
  }, 15000);

  it('records an outage and keeps the meeting (US-MTG-04 AC4)', async () => {
    const id = await seedMeeting(
      pool,
      orgs.connected,
      'Sponsor sync [calendar-down]',
    );

    publish(orgs.connected, id);
    const row = await waitForStatus(id, 'failed');

    expect(row.sync_error).toBe('Google Calendar is unavailable right now.');
  }, 15000);
});

async function seedOrg(pool: Pool, suffix: string): Promise<number> {
  const org = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
    [`${SLUG}-${suffix}`],
  );
  return Number(org.rows[0].id);
}

async function seedConnection(
  pool: Pool,
  organizationId: number,
  refreshTokenCipher: Buffer,
): Promise<void> {
  await pool.query(
    `INSERT INTO calendar_connections
       (organization_id, status, account_email, refresh_token_cipher, connected_at)
     VALUES ($1, 'connected', 'calendar@example.test', $2, now())`,
    [organizationId, refreshTokenCipher],
  );
}

/** A Video meeting tomorrow, `pending` as eventa-api saves every meeting. */
async function seedMeeting(
  pool: Pool,
  organizationId: number,
  title: string,
): Promise<string> {
  const meeting = await pool.query<{ id: string }>(
    `INSERT INTO meetings
       (organization_id, title, meeting_date, start_time, end_time, type, mode,
        person, guest_email)
     VALUES ($1, $2, CURRENT_DATE + 1, '14:00', '15:00', 'Venue', 'Video',
             'Somchai', $3)
     RETURNING id`,
    [organizationId, title, GUEST],
  );
  return meeting.rows[0].id;
}

/** Organizations cascade to their meetings and calendar connection. */
async function cleanup(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM organizations WHERE slug LIKE 'meeting-it-%'`);
}

/**
 * The outage case leaves a copy on the 5-second retry queue. Delete the whole
 * isolated topology so nothing comes back into the next run.
 */
async function tearDownTopology(channel: Channel | undefined): Promise<void> {
  if (!channel) return;
  const queues = [
    QUEUE,
    `${QUEUE}.dlq`,
    ...RETRY_DELAYS_MS.map((ms) => `${QUEUE}.retry.${ms}`),
  ];
  for (const queue of queues)
    await channel.deleteQueue(queue).catch(() => undefined);
  await channel.deleteExchange(EXCHANGE).catch(() => undefined);
  await channel.deleteExchange(`${EXCHANGE}.dlx`).catch(() => undefined);
}
