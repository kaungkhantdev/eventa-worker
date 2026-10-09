import {
  PROGRAM_SESSION_CHANGED,
  sessionChangedSchema,
} from './session-changed.schema';

/** A message eventa-api would really publish for this routing key. */
function payload(): Record<string, unknown> {
  return {
    version: 1,
    organizationId: 7,
    eventId: 'evt-1',
    sessionId: 'ses-1',
    title: 'Opening keynote',
    previous: { day: 1, startTime: '09:00', endTime: '10:00', room: 'Hall A' },
    current: { day: 1, startTime: '11:00', endTime: '12:00', room: 'Hall B' },
    occurredAt: '2026-10-01T04:00:00.000Z',
  };
}

describe('sessionChangedSchema', () => {
  it('reads the routing key eventa-api publishes', () => {
    expect(PROGRAM_SESSION_CHANGED).toBe('program.session_changed');
  });

  it('accepts a message as the producer sends it', () => {
    expect(() => sessionChangedSchema.parse(payload())).not.toThrow();
  });

  /*
   * The tolerant-reader rule, for the one field this handler never reads.
   *
   * `occurredAt` was declared REQUIRED while nothing in the module referenced
   * it, so a producer that stopped sending it would have failed `schema.parse`,
   * ridden the retry ladder and dead-lettered the notice — no mail at all, over
   * a field that could not have changed a word of it. Both sibling schemas had
   * already gone the other way for this reason.
   */
  it('accepts a message with no occurredAt, because nothing reads it', () => {
    const withoutIt = { ...payload() };
    delete withoutIt.occurredAt;

    expect(() => sessionChangedSchema.parse(withoutIt)).not.toThrow();
  });

  // Unknown fields are stripped, never rejected: the producer may add one.
  it('strips a field it has never heard of rather than refusing the message', () => {
    const parsed = sessionChangedSchema.parse({ ...payload(), surprise: 'x' });

    expect(parsed).not.toHaveProperty('surprise');
  });

  // What it genuinely cannot work without must still be refused.
  it('refuses a message with no sitting to describe', () => {
    const withoutCurrent = { ...payload() };
    delete withoutCurrent.current;

    expect(() => sessionChangedSchema.parse(withoutCurrent)).toThrow();
  });
});
