import { readRefinement } from './refinement-read';

const FALLBACK = 'en';

/** A node-postgres rejection, whose `code` is the SQLSTATE. */
function pg(code: string): Error {
  return Object.assign(new Error('postgres said no'), { code });
}

/**
 * A read that fails the way a repository does: a promise that rejects a tick
 * later, with whatever the driver threw. Built by throwing inside a `then`
 * rather than with `Promise.reject`, because a repository may well reject with
 * something that is not an Error at all — and surviving that is the point.
 */
function failing(cause: unknown): () => Promise<never> {
  return () =>
    Promise.resolve().then<never>(() => {
      throw cause;
    });
}

describe('readRefinement', () => {
  it('passes the read straight through when it succeeds', async () => {
    const codes: (string | null)[] = [];

    const locale = await readRefinement(
      () => Promise.resolve('th'),
      FALLBACK,
      (code) => codes.push(code),
    );

    expect(locale).toBe('th');
    expect(codes).toEqual([]);
  });

  /**
   * The contract, and the reason this exists as a named function with a test
   * rather than as a `catch` in two handlers: a refinement lookup CANNOT stop
   * the send. Not an outage, not a bug, not something that is not an Error at
   * all. There is no failure for which withholding a security notice is the
   * right answer, so there is no failure this discriminates on.
   */
  const failures: readonly unknown[] = [
    pg('ECONNREFUSED'),
    pg('42703'),
    new Error('timeout expired'),
    new TypeError('not a function'),
    'a thrown string',
    undefined,
    null,
  ];

  it.each(failures.map((cause, index) => [index, cause]))(
    'resolves with the fallback whatever the read rejects with (%i)',
    async (_index, cause) => {
      await expect(
        readRefinement(failing(cause), FALLBACK, () => undefined),
      ).resolves.toBe(FALLBACK);
    },
  );

  /**
   * The code is what makes a degraded send diagnosable without logging the
   * error itself — a node-postgres error can carry more than the ids that were
   * bound, and these handlers mail people about their own accounts.
   */
  it('hands the caller the error code for its warn line', async () => {
    const codes: (string | null)[] = [];

    await readRefinement(failing(pg('53300')), FALLBACK, (code) =>
      codes.push(code),
    );

    expect(codes).toEqual(['53300']);
  });

  it('reports no code for a failure that carries none', async () => {
    const codes: (string | null)[] = [];

    await readRefinement(
      failing(new TypeError('not a function')),
      FALLBACK,
      (code) => codes.push(code),
    );

    expect(codes).toEqual([null]);
  });

  /** A read that throws before it ever returns a promise is still a failure. */
  it('catches a read that throws synchronously', async () => {
    await expect(
      readRefinement(
        () => {
          throw new TypeError('not a function');
        },
        FALLBACK,
        () => undefined,
      ),
    ).resolves.toBe(FALLBACK);
  });
});

describe('readRefinement, when the read does not fail but misbehaves', () => {
  /*
   * A rejection is not the only way a read can cost the reader the message. A
   * saturated pool, a lock held on `users`, or a TCP blackhole after a failover
   * gives a promise that never settles at all — and nothing else bounds it:
   * `DatabaseModule` builds its Pool with no `connectionTimeoutMillis` (pg-pool
   * reads 0 as "wait forever"), no `statement_timeout` and no `query_timeout`,
   * and `ConsumerService.onMessage` puts no deadline on a handler either. So
   * the alert simply never went out, with no warn line and no counter.
   */
  it('falls back when the read never settles, rather than waiting forever', async () => {
    const reported: (string | null)[] = [];
    const result = await readRefinement(
      () => new Promise<string>(() => {}),
      'en',
      (code) => reported.push(code),
      5,
    );

    expect(result).toBe('en');
    expect(reported).toEqual([null]);
  });

  /*
   * The docstring asks `onDegraded` not to throw. Asking is not enforcing, and
   * the one path whose whole purpose is to be loud about a degradation must not
   * be the path that turns it into a lost message.
   */
  it('still falls back when the degradation report itself throws', async () => {
    const result = await readRefinement(
      () => Promise.reject(new Error('down')),
      'en',
      () => {
        throw new Error('the metric backend is also down');
      },
    );

    expect(result).toBe('en');
  });
});
