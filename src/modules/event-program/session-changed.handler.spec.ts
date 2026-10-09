import { Logger } from '@nestjs/common';
import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type {
  IdempotencyService,
  SentLedger,
} from '../../common/idempotency/idempotency.service';
import type { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import { SESSION_CHANGE_SLUG } from '../../db/schema/messaging';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { EventRecipientsRepository } from '../events/event-recipients.repository';
import type { EventProgramRepository } from './event-program.repository';
import { SessionChangedHandler } from './session-changed.handler';
import { PROGRAM_SESSION_CHANGED } from './session-changed.schema';

const ctx: MessageContext = {
  routingKey: PROGRAM_SESSION_CHANGED,
  messageId: 'm1',
  correlationId: 'c1',
};

/** The wire payload, as eventa-api's `sessionChangedEvent` writes it. */
const rawEvent = {
  version: 1,
  organizationId: 7,
  eventId: 'e1',
  sessionId: 's1',
  title: 'Opening Keynote',
  previous: {
    day: 1,
    startTime: '14:00:00',
    endTime: '15:00:00',
    room: 'Hall A',
  },
  current: {
    day: 1,
    startTime: '14:00:00',
    endTime: '15:00:00',
    room: 'Hall B',
  },
  occurredAt: '2026-10-01T04:00:00.000Z',
};

const eventContext = {
  name: 'Bangkok Summit 2026',
  startAt: new Date('2026-10-12T03:00:00.000Z'),
  timezone: 'Asia/Bangkok',
  status: 'upcoming',
};

/** Idempotency stub backing recipientLedger() with a shared in-memory Set. */
function stubIdempotency(seed: string[] = []): {
  idempotency: IdempotencyService;
  ledgerStore: Set<string>;
} {
  const ledgerStore = new Set<string>(seed);
  const ledger: SentLedger = {
    wasSent: (key) => Promise.resolve(ledgerStore.has(key)),
    markSent: (key) => {
      ledgerStore.add(key);
      return Promise.resolve();
    },
  };
  const idempotency = {
    recipientLedger: jest.fn(() => ledger),
  } as unknown as IdempotencyService;
  return { idempotency, ledgerStore };
}

describe('SessionChangedHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let recipients: jest.Mocked<EventRecipientsRepository>;
  let templates: jest.Mocked<MessageTemplatesRepository>;
  let events: jest.Mocked<EventProgramRepository>;
  let idempotency: IdempotencyService;
  let ledgerStore: Set<string>;
  let handler: SessionChangedHandler;

  const build = (seed: string[] = []): SessionChangedHandler => {
    ({ idempotency, ledgerStore } = stubIdempotency(seed));
    return new SessionChangedHandler(
      events,
      recipients,
      templates,
      email,
      idempotency,
    );
  };

  beforeEach(() => {
    sent = [];
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    recipients = {
      confirmedRecipients: jest.fn().mockResolvedValue([
        { email: 'a@example.com', name: 'Somchai' },
        { email: 'b@example.com', name: 'Malee' },
      ]),
      attendeeLocales: jest.fn().mockResolvedValue(new Map()),
      fallbackLocale: jest.fn().mockResolvedValue('en'),
    } as unknown as jest.Mocked<EventRecipientsRepository>;
    templates = {
      isActive: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<MessageTemplatesRepository>;
    events = {
      eventContext: jest.fn().mockResolvedValue(eventContext),
    } as unknown as jest.Mocked<EventProgramRepository>;
    handler = build();
  });

  it('binds the routing key eventa-api publishes', () => {
    // The whole defect this handler exists for: with nothing bound, the topic
    // exchange discards the message — no failure, no retry, no dead letter.
    expect(handler.routingKey).toBe('program.session_changed');
  });

  it('tells every confirmed attendee, one message each', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com']);
    // One send per person, never a shared To/CC: no attendee sees another's
    // address.
    expect(sent[0].to).not.toContain('b@example.com');
    expect(sent[0].text).toContain('Where: Hall A → Hall B');
    expect(sent[0].text).toContain('Opening Keynote');
  });

  it('logs the delivery under the catalog slug the organizer sees', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].delivery).toEqual({
      organizationId: 7,
      kind: SESSION_CHANGE_SLUG,
      recipientName: 'Somchai',
      eventId: 'e1',
    });
  });

  it('is silent when the organizer switched the notice off', async () => {
    templates.isActive.mockResolvedValue(false);

    await handler.handle(rawEvent, ctx);

    expect(sent).toHaveLength(0);
    // And no list of names and addresses is read for a message nobody gets.
    expect(recipients.confirmedRecipients).not.toHaveBeenCalled();
  });

  it('asks about the session-change switch, not another message’s', async () => {
    await handler.handle(rawEvent, ctx);

    expect(templates.isActive).toHaveBeenCalledWith(7, SESSION_CHANGE_SLUG);
  });

  it('says nothing when the sitting did not actually move', async () => {
    // A redelivery or a DLQ replay carries the same payload again, and a
    // producer that one day emits an unchanged pair must not mail anybody
    // "this session changed" with nothing to show for it.
    await handler.handle({ ...rawEvent, current: rawEvent.previous }, ctx);

    expect(sent).toHaveLength(0);
  });

  it('says nothing once the event itself is cancelled', async () => {
    // The queue can run behind. Nobody is coming to a cancelled event, and
    // they were already told it is off.
    events.eventContext.mockResolvedValue({
      ...eventContext,
      status: 'cancelled',
    });

    await handler.handle(rawEvent, ctx);

    expect(sent).toHaveLength(0);
  });

  it('says nothing when the event is gone', async () => {
    events.eventContext.mockResolvedValue(null);

    await handler.handle(rawEvent, ctx);

    expect(sent).toHaveLength(0);
  });

  it('writes to each reader in their own language', async () => {
    recipients.attendeeLocales.mockResolvedValue(
      new Map([['b@example.com', 'th']]),
    );

    await handler.handle(rawEvent, ctx);

    expect(sent[0].text).toContain('Hi Somchai,');
    expect(sent[1].text).toContain('สวัสดีคุณ Malee');
  });

  it('reads the whole batch’s languages in one query, not one per person', async () => {
    await handler.handle(rawEvent, ctx);

    expect(recipients.attendeeLocales).toHaveBeenCalledTimes(1);
    expect(recipients.attendeeLocales).toHaveBeenCalledWith([
      'a@example.com',
      'b@example.com',
    ]);
  });

  it('delivers only the un-sent tail when a run is re-processed', async () => {
    // Claiming a recipient BEFORE the send would lose them entirely; deduping
    // only on the message id would drop the tail of an interrupted run.
    handler = build(['a@example.com']);

    await handler.handle(rawEvent, ctx);

    expect(sent.map((m) => m.to)).toEqual(['b@example.com']);
    expect(ledgerStore.has('b@example.com')).toBe(true);
  });

  it('records each recipient only after their message lands', async () => {
    email.send = jest.fn(() => Promise.reject(new Error('smtp down')));

    await expect(handler.handle(rawEvent, ctx)).rejects.toThrow();

    expect(ledgerStore.size).toBe(0);
  });

  it('fails loudly on a partial failure, so the message is retried', async () => {
    email.send = jest.fn((m: EmailMessage) =>
      m.to === 'b@example.com'
        ? Promise.reject(new Error('mailbox full'))
        : Promise.resolve(),
    );

    await expect(handler.handle(rawEvent, ctx)).rejects.toThrow(/1\/2/);
  });

  it('reads a payload with unknown fields and no version', async () => {
    // Tolerant reader: a schema that refuses a valid api message dead-letters
    // real traffic.
    const { version, ...noVersion } = rawEvent;
    expect(version).toBe(1); // the fixture mirrors what the producer writes

    await handler.handle({ ...noVersion, mood: 'chaotic' }, ctx);

    expect(sent).toHaveLength(2);
  });

  it('never writes a name or an address to the log', async () => {
    const logged: unknown[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((...args) => {
      logged.push(...args);
    });

    await handler.handle(rawEvent, ctx);

    const line = JSON.stringify(logged);
    expect(line).not.toContain('@example.com');
    expect(line).not.toContain('Somchai');
    expect(line).toContain('s1');
  });

  it('fans out with a ledger scoped to this message', async () => {
    await handler.handle(rawEvent, ctx);

    expect(idempotency.recipientLedger).toHaveBeenCalledWith('m1');
  });
});
