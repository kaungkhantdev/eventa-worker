import type {
  EmailMessage,
  EmailProvider,
} from '../../common/email/email.provider';
import type { MessageContext } from '../../rabbitmq/message-handler.interface';
import { MemberInvitedHandler } from './member-invited.handler';

const ctx: MessageContext = {
  routingKey: 'identity.member_invited',
  messageId: '42',
  correlationId: 'corr-1',
};

const rawEvent = {
  version: 1,
  organizationId: 7,
  userId: 'u1',
  name: 'Somchai',
  email: 'somchai@acme.co.th',
  organizationName: 'Acme Events',
  acceptUrl: 'https://web.test/auth/accept-invite?token=ITOKEN',
  occurredAt: '2026-10-10T08:00:00.000Z',
};

/**
 * US-SET-11: "they appear as 'Invited' and receive a join link by email."
 *
 * They appeared as Invited from the first day; the link was handed back in
 * the API's response and never sent, which `InviteResponseDto` admitted in
 * its own docstring. This handler is the half that was missing.
 */
describe('MemberInvitedHandler', () => {
  let sent: EmailMessage[];
  let email: EmailProvider;
  let handler: MemberInvitedHandler;

  beforeEach(() => {
    sent = [];
    email = {
      send: jest.fn((m: EmailMessage) => {
        sent.push(m);
        return Promise.resolve();
      }),
    };
    handler = new MemberInvitedHandler(email);
  });

  it('subscribes to the member-invited routing key', () => {
    expect(handler.routingKey).toBe('identity.member_invited');
  });

  it('sends the join link to the person invited', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('somchai@acme.co.th');
    expect(sent[0].text).toContain(
      'https://web.test/auth/accept-invite?token=ITOKEN',
    );
  });

  /** An invitation to "a workspace" is one nobody can safely accept. */
  it('says which workspace, in the subject and the body', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].subject).toContain('Acme Events');
    expect(sent[0].text).toContain('Acme Events');
  });

  it('greets the person by name', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].text.split('\n')[0]).toBe('Hi Somchai,');
  });

  /**
   * The name is typed by the inviting ADMIN about somebody else, and this
   * mail carries a credential — so it takes the security rule rather than
   * the sanitising one, and greets nobody when nothing name-shaped survives.
   */
  it('greets without a name rather than print a lure', async () => {
    await handler.handle(
      { ...rawEvent, name: 'URGENT call 0812345678 to verify' },
      ctx,
    );

    expect(sent[0].text.split('\n')[0]).toBe('Hi,');
    expect(sent[0].text).not.toContain('0812345678');
  });

  /** A second line in a subject is a second header. */
  it('cannot have a line added through the workspace name', async () => {
    await handler.handle(
      { ...rawEvent, organizationName: 'Acme\nBcc: victim@evil.test' },
      ctx,
    );

    expect(sent[0].subject).not.toMatch(/[\r\n]/);
    expect(sent[0].text).not.toMatch(/^Bcc:/m);
  });

  /**
   * Account mail is not the organizer's message log: filing somebody's own
   * invitation under a workspace would show it to colleagues who have no
   * business reading it.
   */
  it('carries no delivery context', async () => {
    await handler.handle(rawEvent, ctx);

    expect(sent[0].delivery).toBeUndefined();
  });
});
