import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { MeetingSyncLock } from './meeting-sync.lock';

const MEETING_ID = '3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b';
const KEY = `lock:meeting-sync:${MEETING_ID}`;

/**
 * Two deliveries for one meeting must not talk to Google at once — a patch and
 * a delete interleaved can resurrect a cancelled invite. The lock is Redis,
 * not a row lock, so a sync never holds a pg connection across an HTTP call.
 */
describe('MeetingSyncLock', () => {
  let redis: { set: jest.Mock; eval: jest.Mock };
  let lock: MeetingSyncLock;

  beforeEach(() => {
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };
    lock = new MeetingSyncLock(redis as unknown as Redis);
  });

  afterEach(() => jest.restoreAllMocks());

  it('takes the lock with a random token, for a minute, only if it is free', async () => {
    const token = await lock.acquire(MEETING_ID);

    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(redis.set).toHaveBeenCalledWith(KEY, token, 'PX', 60_000, 'NX');
  });

  it('hands out a different token each time', async () => {
    const first = await lock.acquire(MEETING_ID);
    const second = await lock.acquire(MEETING_ID);
    expect(first).not.toBe(second);
  });

  it('answers null when somebody else holds it', async () => {
    redis.set.mockResolvedValue(null);

    await expect(lock.acquire(MEETING_ID)).resolves.toBeNull();
  });

  it('releases only its own lock — compare and delete, atomically', async () => {
    await lock.release(MEETING_ID, 'my-token');

    const [script, keys, key, token] = redis.eval.mock.calls[0] as [
      string,
      number,
      string,
      string,
    ];
    expect(script).toBe(
      "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
    );
    expect(keys).toBe(1);
    expect(key).toBe(KEY);
    expect(token).toBe('my-token');
  });

  it('does not fail the sync when the release cannot reach Redis', async () => {
    // The lock lapses on its own within a minute; failing a sync that already
    // reached Google would only make it run again.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(lock.release(MEETING_ID, 'my-token')).resolves.toBeUndefined();
  });
});
