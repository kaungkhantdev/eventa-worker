import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import type {
  DueEvent,
  ScheduledMessagesRepository,
} from './scheduled-messages.repository';
import { ScheduledMessagesService } from './scheduled-messages.service';
import type { ScheduledSender } from './scheduled-sender';

const NOW = new Date('2026-07-10T09:00:00.000Z');
const EVENT: DueEvent = {
  organizationId: 7,
  eventId: 'e-1',
  eventName: 'Bangkok Summit 2026',
  startAt: new Date('2026-07-11T02:00:00Z'),
  timezone: 'Asia/Bangkok',
  venueName: 'QSNCC',
  city: 'Bangkok',
  isOnline: false,
  onlineNote: null,
};

describe('ScheduledMessagesService (US-MSG-01/08)', () => {
  let runs: jest.Mocked<ScheduledMessagesRepository>;
  let sender: jest.Mocked<ScheduledSender>;

  // An options object: passing `undefined` to a defaulted parameter USES the
  // default, which would make "no web address" impossible to express.
  const build = ({
    webUrl = 'https://web.test',
  }: { webUrl?: string | null } = {}) => {
    const values: Record<string, unknown> = {
      PUBLIC_WEB_URL: webUrl ?? undefined,
      EVENT_REMINDER_LEAD_HOURS: 24,
      FEEDBACK_REQUEST_DELAY_HOURS: 24,
      FEEDBACK_REQUEST_WINDOW_DAYS: 7,
      FEEDBACK_REQUEST_BATCH: 20,
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService<Env, true>;
    return new ScheduledMessagesService(runs, sender, config, {
      now: () => NOW,
    });
  };

  /** What a message said to one English reader named Anan. */
  const said = (): { subject: string; text: string } => {
    const compose = sender.send.mock.calls[0][4];
    return compose({
      name: 'Anan',
      locale: 'en',
      wording: { subject: null, opening: null },
    });
  };

  beforeEach(() => {
    runs = {
      remindersDue: jest.fn().mockResolvedValue([EVENT]),
      thankYousDue: jest.fn().mockResolvedValue([EVENT]),
    } as unknown as jest.Mocked<ScheduledMessagesRepository>;
    sender = {
      send: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ScheduledSender>;
  });

  describe('the reminder', () => {
    it('looks a day ahead', async () => {
      await build().sendReminders();
      expect(runs.remindersDue).toHaveBeenCalledWith({
        now: NOW,
        leadMs: 24 * 60 * 60 * 1000,
        limit: 20,
      });
    });

    it('says when and where, and links to the tickets', async () => {
      await build().sendReminders();
      const { text } = said();
      expect(text).toContain('QSNCC, Bangkok');
      expect(text).toContain('https://web.test/portal/my-events');
    });

    it('offers the venue to the organizer’s wording', async () => {
      await build().sendReminders();
      expect(sender.send.mock.calls[0][3]).toMatchObject({
        event_name: 'Bangkok Summit 2026',
        event_venue: 'QSNCC, Bangkok',
      });
    });

    it('names an online event by its note, not a blank venue', async () => {
      runs.remindersDue.mockResolvedValue([
        {
          ...EVENT,
          isOnline: true,
          onlineNote: 'Zoom link in your ticket',
          venueName: null,
          city: null,
        },
      ]);
      await build().sendReminders();
      expect(said().text).toContain('Zoom link in your ticket');
    });
  });

  describe('the thank-you', () => {
    it('links to the event’s survey', async () => {
      await build().sendThankYous();
      expect(said().text).toContain('https://web.test/portal/survey?event=e-1');
      expect(sender.send.mock.calls[0][3]).toMatchObject({
        survey_url: 'https://web.test/portal/survey?event=e-1',
      });
    });
  });

  it('does nothing at all without a web address to link to', async () => {
    // Every one of these messages carries a link, and a link with no address
    // is dead in a mail client.
    const service = build({ webUrl: null });
    await service.sendReminders();
    await service.sendThankYous();
    expect(runs.remindersDue).not.toHaveBeenCalled();
    expect(runs.thankYousDue).not.toHaveBeenCalled();
  });

  it('counts only the events it actually sent to', async () => {
    sender.send.mockResolvedValue(false); // switched off
    expect(await build().sendReminders()).toBe(0);
  });
});
