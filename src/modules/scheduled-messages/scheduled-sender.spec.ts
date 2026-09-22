import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type {
  IdempotencyService,
  SentLedger,
} from '../../common/idempotency/idempotency.service';
import type { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import type { EventRecipientsRepository } from '../events/event-recipients.repository';
import type {
  DueEvent,
  ScheduledMessagesRepository,
} from './scheduled-messages.repository';
import { ScheduledSender } from './scheduled-sender';

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

describe('ScheduledSender — sending one scheduled message to an event', () => {
  let sent: EmailMessage[];
  let runs: jest.Mocked<ScheduledMessagesRepository>;
  let recipients: jest.Mocked<EventRecipientsRepository>;
  let templates: jest.Mocked<MessageTemplatesRepository>;
  let ledger: Set<string>;
  let ledgerKeys: string[];
  let email: EmailProvider;
  let sender: ScheduledSender;

  const compose = jest.fn(
    ({
      name,
      wording,
    }: {
      name: string;
      wording: { subject: string | null; opening: string | null };
    }) => ({
      subject: wording.subject ?? `Hello ${name}`,
      text: wording.opening ?? `Body for ${name}`,
    }),
  );

  beforeEach(() => {
    sent = [];
    ledger = new Set();
    ledgerKeys = [];
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    runs = {
      claim: jest.fn().mockResolvedValue(undefined),
      complete: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ScheduledMessagesRepository>;
    recipients = {
      confirmedRecipients: jest
        .fn()
        .mockResolvedValue([{ email: 'anan@x.test', name: 'Anan' }]),
      attendeeLocales: jest.fn().mockResolvedValue(new Map()),
      fallbackLocale: jest.fn().mockResolvedValue('en'),
    } as unknown as jest.Mocked<EventRecipientsRepository>;
    templates = {
      isActive: jest.fn().mockResolvedValue(true),
      wordingFor: jest.fn().mockResolvedValue({
        subjectEn: null,
        bodyEn: null,
        subjectTh: null,
        bodyTh: null,
      }),
    } as unknown as jest.Mocked<MessageTemplatesRepository>;
    const store: SentLedger = {
      wasSent: (key) => Promise.resolve(ledger.has(key)),
      markSent: (key) => {
        ledger.add(key);
        return Promise.resolve();
      },
    };
    const idempotency = {
      recipientLedger: jest.fn((key: string) => {
        ledgerKeys.push(key);
        return store;
      }),
    } as unknown as IdempotencyService;
    sender = new ScheduledSender(
      runs,
      recipients,
      templates,
      email,
      idempotency,
    );
  });

  const send = () =>
    sender.send(
      EVENT,
      'event-reminder',
      NOW,
      { event_name: EVENT.eventName },
      compose,
    );

  it('sends to every attendee and tags each for the delivery log', async () => {
    await send();
    expect(sent[0]).toMatchObject({ to: 'anan@x.test', subject: 'Hello Anan' });
    expect(sent[0].delivery).toMatchObject({
      kind: 'event-reminder',
      eventId: 'e-1',
    });
  });

  it('marks the run done only once everybody is reached', async () => {
    await send();
    expect(runs.claim).toHaveBeenCalledWith(EVENT, 'event-reminder', NOW);
    expect(runs.complete).toHaveBeenCalledWith(EVENT, 'event-reminder', NOW);
  });

  it('leaves a half-finished run open, so the next one resumes it', async () => {
    // Marking it done would strand the attendees who were never reached.
    (email.send as jest.Mock).mockRejectedValue(new Error('smtp down'));
    await send();
    expect(runs.complete).not.toHaveBeenCalled();
  });

  it('keys the ledger on the kind AND the event', async () => {
    // A cron has no broker message id. Keyed on the event alone, an event's
    // reminder would mark people as already thanked, and they would never get
    // the thank-you.
    await send();
    expect(ledgerKeys).toEqual(['event-reminder:e-1']);
  });

  it('does not repeat anybody when a run is resumed', async () => {
    ledger.add('anan@x.test');
    await send();
    expect(sent).toHaveLength(0);
  });

  it('sends nothing, and does not finish the run, when switched off', async () => {
    // Switching it back on inside the window should still reach people.
    templates.isActive.mockResolvedValue(false);
    expect(await send()).toBe(false);
    expect(sent).toHaveLength(0);
    expect(runs.claim).not.toHaveBeenCalled();
  });

  it('hands the composer the organizer’s wording, with the fields filled', async () => {
    templates.wordingFor.mockResolvedValue({
      subjectEn: '{{event_name}} is tomorrow',
      bodyEn: 'See you, {{first_name}}',
      subjectTh: null,
      bodyTh: null,
    });
    await send();
    expect(sent[0].subject).toBe('Bangkok Summit 2026 is tomorrow');
    expect(sent[0].text).toBe('See you, Anan');
  });

  it('gives each reader their own language', async () => {
    recipients.attendeeLocales.mockResolvedValue(
      new Map([['anan@x.test', 'th' as const]]),
    );
    await send();
    expect(compose).toHaveBeenLastCalledWith(
      expect.objectContaining({ locale: 'th' }),
    );
  });
});
