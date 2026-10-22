import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS } from '../../common/idempotency/idempotency.constants';
import { safeError } from '../../common/logging/safe-error';
import {
  KEY_PREFIX,
  LOCK_TTL_MS,
  RELEASE_SCRIPT,
} from '../../common/constants/meetings.constants';

/**
 * One sync per meeting at a time, across every replica.
 *
 * The consumer prefetches and the worker runs several replicas, so two
 * deliveries for one meeting (a reschedule hard on the heels of a create, a
 * cancel racing a retry) can be in flight together — and a patch interleaved
 * with a delete can put a cancelled invite back on the guest's calendar. The
 * loser is told "busy" and comes back off the retry ladder, by which time the
 * winner has finished and the row says what is left to do.
 *
 * Redis rather than a row lock, so a sync never holds a pg connection open
 * across Google's HTTP calls.
 */
@Injectable()
export class MeetingSyncLock {
  private readonly logger = new Logger(MeetingSyncLock.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** The token that proves ownership, or null when somebody else holds it. */
  async acquire(meetingId: string): Promise<string | null> {
    const token = randomUUID();
    const taken = await this.redis.set(
      KEY_PREFIX + meetingId,
      token,
      'PX',
      LOCK_TTL_MS,
      'NX',
    );
    return taken === 'OK' ? token : null;
  }

  /**
   * Best effort. A release that cannot reach Redis is logged and dropped: the
   * lock lapses by itself, and failing a sync that already reached Google
   * would only send it round again.
   */
  async release(meetingId: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, KEY_PREFIX + meetingId, token);
    } catch (err) {
      this.logger.warn(
        { meetingId, err: safeError(err) },
        'Could not release the meeting sync lock — it will lapse by itself',
      );
    }
  }
}
