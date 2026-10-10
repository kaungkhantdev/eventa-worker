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

  it('flattens every subject that borrows somebody else’s text', () => {
    const unguarded = all
      .filter((b) => b.borrows && !b.flattens)
      .map((b) => `${b.file} :: ${b.name}`);

    expect(unguarded).toEqual([]);
  });
});
