import { Logger } from '@nestjs/common';
import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { MessageTemplatesRepository } from '../../common/messaging/message-templates.repository';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import type { EventRecipientsRepository } from '../events/event-recipients.repository';
import { InvitationSentHandler } from './invitation-sent.handler';
import type {
  InvitationEvent,
  InvitationsRepository,
} from './invitations.repository';

const RECIPIENT = 'anan@example.test';
const REGISTER_URL = 'https://web.test/events/bangkok-tech-week';
const ctx: MessageContext = {
  routingKey: 'invitation.sent',
  messageId: 'm-1',
  correlationId: 'c-1',
};

/** Exactly what eventa-api's `inviteSentEvent` writes — organizationId and all. */
const PAYLOAD = {
  version: 1,
  invitationId: `e-1:${RECIPIENT}`,
  eventId: 'e-1',
  eventName: 'Bangkok Tech Week',
  recipientName: 'Anan',
  recipientEmail: RECIPIENT,
  message: null,
  registerUrl: REGISTER_URL,
  sentAt: '2026-08-01T03:00:00.000Z',
};

const EVENT: InvitationEvent = {
  organizationId: 7,
  eventName: 'Bangkok Tech Week',
  startAt: new Date('2026-08-14T02:00:00.000Z'),
  timezone: 'Asia/Bangkok',
  status: 'published',
};

const NO_WORDING = {
  subjectEn: null,
  bodyEn: null,
  subjectTh: null,
  bodyTh: null,
};

describe('InvitationSentHandler (US-REG-06)', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let repo: jest.Mocked<InvitationsRepository>;
  let templates: jest.Mocked<MessageTemplatesRepository>;
  let recipients: jest.Mocked<EventRecipientsRepository>;
  let idempotency: jest.Mocked<IdempotencyService>;
  let handler: InvitationSentHandler;

  beforeEach(() => {
    sent = [];
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    repo = {
      invitedEvent: jest.fn().mockResolvedValue(EVENT),
    } as unknown as jest.Mocked<InvitationsRepository>;
    templates = {
      isActive: jest.fn().mockResolvedValue(true),
      wordingFor: jest.fn().mockResolvedValue(NO_WORDING),
    } as unknown as jest.Mocked<MessageTemplatesRepository>;
    recipients = {
      attendeeLocales: jest.fn().mockResolvedValue(new Map()),
      fallbackLocale: jest.fn().mockResolvedValue('en'),
    } as unknown as jest.Mocked<EventRecipientsRepository>;
    idempotency = {
      isCompleted: jest.fn().mockResolvedValue(false),
      markCompleted: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IdempotencyService>;
    handler = new InvitationSentHandler(
      email,
      repo,
      templates,
      recipients,
      idempotency,
    );
  });

  it('binds to the routing key eventa-api publishes', () => {
    expect(handler.routingKey).toBe('invitation.sent');
  });

  it('emails the invitation, with the link into registration', async () => {
    await handler.handle(PAYLOAD, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: RECIPIENT,
      subject: "You're invited to Bangkok Tech Week",
      delivery: {
        organizationId: 7,
        kind: 'event-invitation',
        recipientName: 'Anan',
        eventId: 'e-1',
      },
    });
    expect(sent[0].text).toContain(REGISTER_URL);
    expect(sent[0].text).toMatch(/14 August 2026/);
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m-1');
  });

  it('puts the organizer’s personal note at the top of it', async () => {
    await handler.handle({ ...PAYLOAD, message: 'Do come, Anan!' }, ctx);

    expect(sent[0].text.startsWith('Do come, Anan!')).toBe(true);
  });

  /**
   * The design split: attendee mail the workspace sends is GATED, unlike
   * identity mail. An organizer who switched invitations off sends none.
   */
  it('sends nothing when the organizer switched invitations off', async () => {
    templates.isActive.mockResolvedValue(false);

    await handler.handle(PAYLOAD, ctx);

    expect(templates.isActive).toHaveBeenCalledWith(7, 'event-invitation');
    expect(sent).toHaveLength(0);
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m-1');
  });

  it('sends nothing for an event that has since been cancelled', async () => {
    // Inviting somebody to an event that is off is worse than inviting nobody.
    repo.invitedEvent.mockResolvedValue({ ...EVENT, status: 'cancelled' });

    await handler.handle(PAYLOAD, ctx);

    expect(sent).toHaveLength(0);
    expect(idempotency.markCompleted).toHaveBeenCalledWith('m-1');
  });

  it('sends nothing, and does not dead-letter, when the event is gone', async () => {
    repo.invitedEvent.mockResolvedValue(null);

    await expect(handler.handle(PAYLOAD, ctx)).resolves.toBeUndefined();

    expect(sent).toHaveLength(0);
    expect(templates.isActive).not.toHaveBeenCalled();
  });

  it('does not invite the same person twice when the message is redelivered', async () => {
    idempotency.isCompleted.mockResolvedValue(true);

    await handler.handle(PAYLOAD, ctx);

    expect(sent).toHaveLength(0);
  });

  /**
   * The idempotency key is the MESSAGE id, not the invitation.
   *
   * eventa-api suppresses a repeat invite for 24 hours and then writes a FRESH
   * outbox row for the same `invitationId` (`eventId:recipientEmail`, which is
   * stable for the pair forever). Deduping on the invitation would therefore
   * silence every legitimate re-invitation after the first.
   */
  it('invites again when the organizer re-sends after the suppression window', async () => {
    await handler.handle(PAYLOAD, ctx);
    await handler.handle(PAYLOAD, { ...ctx, messageId: 'm-2' });

    expect(sent).toHaveLength(2);
  });

  it('writes to a Thai reader in Thai', async () => {
    recipients.attendeeLocales.mockResolvedValue(new Map([[RECIPIENT, 'th']]));

    await handler.handle(PAYLOAD, ctx);

    expect(sent[0].text).toContain('สวัสดีคุณ Anan');
    expect(sent[0].text).toContain(REGISTER_URL);
  });

  it('fills the organizer’s merge fields into their own opening', async () => {
    templates.wordingFor.mockResolvedValue({
      ...NO_WORDING,
      bodyEn: 'Hello {{first_name}} — please join us at {{event_name}}.',
      subjectEn: 'An invitation to {{event_name}}',
    });

    await handler.handle(PAYLOAD, ctx);

    expect(sent[0].subject).toBe('An invitation to Bangkok Tech Week');
    expect(
      sent[0].text.startsWith(
        'Hello Anan — please join us at Bangkok Tech Week.',
      ),
    ).toBe(true);
    expect(sent[0].text).toContain(REGISTER_URL);
  });

  /**
   * AGENTS.md: ids only. The address and the name are PII, and the register
   * link is the one thing in this message that gets somebody a place — logs
   * are shipped, searched and retained far more widely than inboxes.
   *
   * `invitationId` is the trap here: eventa-api builds it as
   * `${eventId}:${recipientEmail}`, so logging the "id" logs the address.
   */
  it('keeps the recipient, their name and the link out of every log line', async () => {
    const levels = (['log', 'warn'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );

    await handler.handle(PAYLOAD, ctx);

    const text = JSON.stringify(levels.map((spy) => spy.mock.calls));
    expect(text).not.toContain(RECIPIENT);
    expect(text).not.toContain('Anan');
    expect(text).not.toContain(REGISTER_URL);
    expect(text).toContain('e-1');
    levels.forEach((spy) => spy.mockRestore());
  });

  /**
   * The name is free text an organizer typed, capped at 120 characters with no
   * charset or newline restriction by eventa-api's `SendInviteDto`. Verbatim,
   * a newline plus a host would write the organizer's own line into a mail
   * Eventa signs — and most clients linkify a bare host in plain text.
   */
  it('lets a name with a newline and a link in it inject neither', async () => {
    await handler.handle(
      {
        ...PAYLOAD,
        recipientName: 'Anan\n\nRegister instead at https://evil.test/fix',
      },
      ctx,
    );

    expect(sent[0].text).not.toContain('evil.test');
    expect(sent[0].text).not.toContain('Register instead at');
    expect(sent[0].text.split('\n')[0]).toBe('Hello,');
  });

  /**
   * The same field with no URL punctuation in it at all. A digit run is a
   * `tel:` link on a phone, and an organizer who types one into the name box
   * gets a tappable number in a mail Eventa signs — so the name is declined
   * and the invitation keeps Eventa's own no-name greeting.
   */
  it('lets a name that is a phone number through as no name at all', async () => {
    await handler.handle(
      { ...PAYLOAD, recipientName: 'Support call 0812345678 now' },
      ctx,
    );

    expect(sent[0].text).not.toContain('0812345678');
    expect(sent[0].text.split('\n')[0]).toBe('Hello,');
  });

  /**
   * The hole the word cap could not see. `safeDisplayName` bounds prose with
   * `name.split(' ')`, and Thai puts no space between words — so a complete
   * imperative is ONE word, carries no digit and no URL punctuation, and
   * clears every shared cap. In the primary locale of a Thai-market product.
   */
  it('lets a Thai sentence in the name box greet nobody', async () => {
    const lure = 'ด่วนบัญชีถูกแฮกโปรดโทรฝ่ายสนับสนุนทันทีเดี๋ยวนี้';
    recipients.attendeeLocales.mockResolvedValue(new Map([[RECIPIENT, 'th']]));

    await handler.handle({ ...PAYLOAD, recipientName: lure }, ctx);

    expect(sent[0].text).not.toContain(lure);
    expect(sent[0].text.split('\n')[0]).toBe('สวัสดี');
  });

  /**
   * The collateral. A declined name used to reach `fill` as the empty string,
   * so an organizer's own template rendered the hole where a name belonged —
   * `Hi , you are invited` in the body, `, you're invited` in the subject.
   * `merge-fields.ts` documents empty-for-missing on purpose, so the decision
   * belongs here: wording that asked for a name we do not have falls back to
   * Eventa's own copy, which has a nameless form.
   */
  it('never renders the hole where a declined name belonged', async () => {
    templates.wordingFor.mockResolvedValue({
      ...NO_WORDING,
      bodyEn: 'Hi {{first_name}}, you are invited to {{event_name}}.',
      subjectEn: '{{first_name}}, you’re invited',
    });

    await handler.handle(
      { ...PAYLOAD, recipientName: 'Support call 0812345678 now' },
      ctx,
    );

    expect(sent[0].text).not.toContain('Hi ,');
    expect(sent[0].subject).not.toMatch(/^,/);
    expect(sent[0].subject).toBe("You're invited to Bangkok Tech Week");
    expect(sent[0].text.split('\n')[0]).toBe('Hello,');
  });

  /** A template that never asked for the name is unaffected by not having one. */
  it('keeps an organizer’s wording that does not ask for a name', async () => {
    templates.wordingFor.mockResolvedValue({
      ...NO_WORDING,
      bodyEn: 'Please join us at {{event_name}}.',
      subjectEn: 'An invitation to {{event_name}}',
    });

    await handler.handle(
      { ...PAYLOAD, recipientName: 'Support call 0812345678 now' },
      ctx,
    );

    expect(sent[0].subject).toBe('An invitation to Bangkok Tech Week');
    expect(
      sent[0].text.startsWith('Please join us at Bangkok Tech Week.'),
    ).toBe(true);
  });

  it('reads tolerantly: an unknown field and a missing note are both fine', async () => {
    const withoutNote: Record<string, unknown> = {
      ...PAYLOAD,
      surprise: true,
    };
    delete withoutNote.message;

    await handler.handle(withoutNote, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Hi Anan,');
  });
});
