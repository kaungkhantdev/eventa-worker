import type { ConfigService } from '@nestjs/config';
import type { Clock } from '../../common/time/clock';
import type { Env } from '../../config/env.validation';
import type {
  DueSweepResult,
  ScheduledAnnouncementsRepository,
  SendDueInput,
} from './scheduled-announcements.repository';
import { ScheduledAnnouncementsService } from './scheduled-announcements.service';

const NOW = new Date('2026-08-05T03:00:00Z');
const BATCH = 25;

function harness(result: DueSweepResult = { sent: [], dropped: [] }) {
  const sendDue = jest.fn<Promise<DueSweepResult>, [SendDueInput]>(() =>
    Promise.resolve(result),
  );
  const repo = { sendDue } as unknown as ScheduledAnnouncementsRepository;
  const values: Partial<Record<keyof Env, unknown>> = {
    SCHEDULED_ANNOUNCEMENTS_BATCH: BATCH,
  };
  const config = {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
  const clock: Clock = { now: () => NOW };
  return {
    service: new ScheduledAnnouncementsService(repo, config, clock),
    sendDue,
  };
}

describe('ScheduledAnnouncementsService (US-MSG-04/05)', () => {
  it('sends what is due now, a configured batch at a time', async () => {
    const { service, sendDue } = harness();

    await service.sendDue();

    expect(sendDue).toHaveBeenCalledWith({ now: NOW, limit: BATCH });
  });

  it('reports how many it sent', async () => {
    const { service } = harness({
      sent: [
        { id: 1, organizationId: 7, recipientCount: 40 },
        { id: 2, organizationId: 8, recipientCount: 0 },
      ],
      dropped: [{ id: 3, organizationId: 7 }],
    });

    await expect(service.sendDue()).resolves.toBe(2);
  });

  it('is quiet when nothing is due', async () => {
    const { service } = harness();

    await expect(service.sendDue()).resolves.toBe(0);
  });

  /**
   * The caller decides what a failure means. The cron logs it so one bad tick
   * cannot take the worker down; a test or an operator calling `sendDue`
   * directly wants to know it failed.
   */
  it('surfaces a failed sweep rather than swallowing it', async () => {
    const { service, sendDue } = harness();
    sendDue.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.sendDue()).rejects.toThrow('connection lost');
  });
});
