import { Injectable } from '@nestjs/common';

/**
 * Abstraction over the system clock, mirroring eventa-api's helper of the same
 * name. Inject `Clock` instead of calling `new Date()` in domain code: it keeps
 * the rule free of an infrastructure dependency and makes time deterministic in
 * tests.
 *
 * An abstract class rather than an interface or a function type on purpose —
 * Nest resolves providers by runtime token, and neither of the others survives
 * compilation to be one.
 */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
