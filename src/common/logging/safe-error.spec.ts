import { safeError } from './safe-error';

/**
 * What may be written about a failure.
 *
 * Eight places logged `{ err }` — the raw error — and pino's serializer emits
 * its message, its stack and every own enumerable property. Three error
 * classes reaching those sites carry personal data:
 *
 * - Drizzle wraps EVERY query rejection as (drizzle-orm@0.45.2/errors.cjs:36)
 *   `` super(`Failed query: ${query}\nparams: ${params}`) `` and also hangs
 *   `query` and `params` on the object, so the statement and its bound values
 *   appear twice. For this service's writes those values are people.
 * - nodemailer puts the recipient in `message`, `response`, `rejected[]` and
 *   `rejectedErrors[].recipient`.
 * - The consumer's dead-letter path logs at ERROR, which production emits.
 */
describe('safeError', () => {
  const EMAIL = 'somchai@example.test';
  const NAME = 'Somchai Jaidee';

  function drizzleFailure(): Error {
    const err = new Error(
      'Failed query: insert into "orders" ("buyer_name","buyer_email") ' +
        `values ($1,$2)\nparams: ${NAME},${EMAIL}`,
    );
    err.stack = `${err.message}\n    at OrdersRepository.create (orders.ts:40:7)`;
    Object.assign(err, {
      query: 'insert into "orders" …',
      params: [NAME, EMAIL],
    });
    err.cause = Object.assign(new Error('deadlock'), {
      code: '40P01',
      constraint: 'orders_pkey',
    });
    return err;
  }

  describe('a failed query', () => {
    it('says what the database refused, not what was bound', () => {
      const safe = safeError(drizzleFailure());

      expect(JSON.stringify(safe)).not.toContain(NAME);
      expect(JSON.stringify(safe)).not.toContain(EMAIL);
      expect(JSON.stringify(safe)).not.toContain('insert into');
      expect(safe.code).toBe('40P01');
      expect(safe.reason).toContain('orders_pkey');
    });

    it('keeps the frames, which are where it happened', () => {
      expect(safeError(drizzleFailure()).at).toContain(
        'OrdersRepository.create',
      );
    });

    /** The wrapper's own enumerable fields carry the same values again. */
    it('carries none of the error’s own properties through', () => {
      const safe: Record<string, unknown> = {
        ...safeError(drizzleFailure()),
      };

      expect(safe.params).toBeUndefined();
      expect(safe.query).toBeUndefined();
    });
  });

  describe('a transport rejection', () => {
    it('masks an address in the message', () => {
      const err = Object.assign(
        new Error(`Can't send mail - all recipients were rejected: <${EMAIL}>`),
        { rejected: [EMAIL], response: `550 5.1.1 <${EMAIL}> unknown` },
      );

      const safe = safeError(err);

      expect(JSON.stringify(safe)).not.toContain(EMAIL);
      // The refusal itself is the diagnosis and must survive the masking.
      expect(safe.reason).toContain('rejected');
    });

    it('masks every address, not just the first', () => {
      const err = new Error(`rejected: a@x.test, b@y.test, c@z.test`);

      expect(safeError(err).reason).not.toMatch(/@(x|y|z)\.test/);
    });
  });

  describe('an ordinary failure', () => {
    /** Over-redacting hides the outages a log exists to show. */
    it('keeps its own words', () => {
      expect(
        safeError(new Error('connect ECONNREFUSED 127.0.0.1:6379')).reason,
      ).toContain('ECONNREFUSED 127.0.0.1:6379');
    });

    it('names the error type, so classes can be counted', () => {
      expect(safeError(new TypeError('x is not a function')).name).toBe(
        'TypeError',
      );
    });

    it('survives something that is not an Error at all', () => {
      expect(safeError('plain string').reason).toBe('plain string');
      expect(safeError(undefined).name).toBe('unknown');
    });
  });
});
