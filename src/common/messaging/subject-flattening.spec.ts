import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every subject this service can send is flattened, enforced over the source.
 *
 * WHY A SOURCE SCAN rather than per-notice cases. Applying `inlineText` is
 * opt-in at each call site and nothing made a notice that skipped it fail:
 * `invitationSubject` was the one builder of twelve that did not, and it was
 * found by measuring every field rather than by reading the list — twice, the
 * list was wrong. A test that enumerates the SOURCE cannot be out of date with
 * it, and it fails on the next notice somebody writes rather than on the next
 * audit somebody runs.
 *
 * The rule: a subject builder either BORROWS text — interpolates something
 * (`${…}`), falls back through the organizer's own `notice.subject`, or calls
 * a copy function with an argument — in which case it must flatten; or it
 * returns one of Eventa's own constants, in which case there is nothing to
 * flatten. Both are fine. Borrowing without flattening is not.
 *
 * A second line in a subject is a second header, and both sources are
 * unconstrained upstream: `CreateEventDto.name` is `@MinLength(3)
 * @MaxLength(120)` and a template subject is `@IsString() @MaxLength(200)`,
 * neither with a charset rule.
 */

const MODULES = join(__dirname, '..', '..', 'modules');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

/** The body of a function, by matching braces from its signature. */
function bodyAt(source: string, from: number): string {
  const open = source.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

interface Builder {
  name: string;
  file: string;
  borrows: boolean;
  flattens: boolean;
}

/**
 * Field names that carry text a person or an organizer typed.
 *
 * A LIST OF NAMES rather than a shape rule, because nothing in the source
 * distinguishes `notice.eventName` (120 characters of anything) from
 * `notice.reference` (generated from a fixed alphabet) or `notice.currency`
 * (an enum). Measuring every field of every body — which is how all of these
 * were found — reported the generated ones as leaks too; they are not, and
 * flattening them would imply a threat that does not exist.
 *
 * Honest about the limit: a NEW field whose name is not here is not checked.
 * That is why the measurement exists and why this list is worth extending
 * when a notice gains a field somebody can type into.
 */
const BORROWED_FIELDS = [
  'attendeeName',
  'buyerName',
  'eventName',
  'holderName',
  'recipientName',
  'room',
  'sessionTitle',
  'ticketLabel',
  'ticketTypeName',
  'whereText',
] as const;

/**
 * Helpers that flatten what they are handed, so passing a field to one is as
 * good as wrapping it.
 *
 * Needed because the flattening is often ONE CALL DOWN:
 * `greeting(locale, notice.attendeeName)` reads the name unwrapped and
 * `greeting` flattens it inside. Without this the check fails on correct
 * code, and a test that cries wolf is one somebody deletes.
 *
 * Add a helper here when it starts flattening on its callers' behalf.
 */
const FLATTENING_SINKS = ['inlineText(', 'greeting(', 'roomChange('];

/** A read that only asks whether the value is there, and prints nothing. */
const PRESENCE_TEST = /^\s*(\?|&&|\|\||\)\s*\?)/;

/** Where a borrowed field is read, printed, and not flattened on the way. */
function unflattenedUses(body: string, file: string): string[] {
  const found: string[] = [];
  for (const field of BORROWED_FIELDS) {
    const uses = body.matchAll(
      new RegExp(`.{0,40}\\.${field}\\b(.{0,6})`, 'g'),
    );
    for (const use of uses) {
      const before = use[0];
      if (FLATTENING_SINKS.some((sink) => before.includes(sink))) continue;
      if (PRESENCE_TEST.test(use[1] ?? '')) continue;
      found.push(`${file} :: .${field}`);
    }
  }
  return found;
}

function builders(): Builder[] {
  const found: Builder[] = [];
  for (const file of sourceFiles(MODULES)) {
    const source = readFileSync(file, 'utf8');
    const signature = /export function (\w*[Ss]ubject)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = signature.exec(source)) !== null) {
      const body = bodyAt(source, match.index);
      found.push({
        name: match[1],
        file: file.slice(file.indexOf('src/')),
        // Interpolation, the organizer's own subject, or a copy function
        // called WITH an argument — `COPY[x].subject` is a constant,
        // `COPY[x].subject(event)` is not.
        borrows: /\$\{|notice\.subject|\.subject\(/.test(body),
        flattens: body.includes('inlineText('),
      });
    }
  }
  return found;
}

describe('every email subject is flattened at its source', () => {
  const all = builders();

  /** Guard on the guard: a scan that finds nothing would pass silently. */
  it('finds the subject builders at all', () => {
    expect(all.length).toBeGreaterThanOrEqual(15);
    expect(all.map((b) => b.name)).toContain('invitationSubject');
  });

  it('finds both kinds, so neither branch of the rule is vacuous', () => {
    expect(all.filter((b) => b.borrows).length).toBeGreaterThan(0);
    expect(all.filter((b) => !b.borrows).length).toBeGreaterThan(0);
  });

  /**
   * Bodies, by the same rule. A subject's second line is a second header; a
   * body's is a line of its own in Eventa's voice, which is how every one of
   * these was found — by poisoning each field and counting lines.
   *
   * The organizer's own multi-line BLOCKS are excluded by name: `opening`,
   * `intro`, `note`, a template `body`, a postal `address`. Those are meant
   * to span lines and flattening them would mangle every honest one.
   */
  it('flattens every borrowed field a body reads', () => {
    const unguarded: string[] = [];
    for (const file of sourceFiles(MODULES)) {
      const source = readFileSync(file, 'utf8');
      const signature = /export function (\w*Body|\w*body)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = signature.exec(source)) !== null) {
        unguarded.push(
          ...unflattenedUses(
            bodyAt(source, match.index),
            `${file.slice(file.indexOf('src/'))} ${match[1]}`,
          ),
        );
      }
    }

    expect(unguarded).toEqual([]);
  });

  it('flattens every subject that borrows somebody else’s text', () => {
    const unguarded = all
      .filter((b) => b.borrows && !b.flattens)
      .map((b) => `${b.file} :: ${b.name}`);

    expect(unguarded).toEqual([]);
  });
});
