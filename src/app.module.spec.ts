import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stand in for the config module so this guard needs no environment at all.
 *
 * `AppConfigModule` calls `ConfigModule.forRoot({ validate: validateEnv })`
 * inside its own `@Module` decorator, and a decorator argument is evaluated
 * when the module is IMPORTED. So merely importing `./app.module` below used to
 * run the zod schema against `process.env`, and with no `.env` in the repo the
 * three variables that have no default — DATABASE_URL, RABBITMQ_URL, REDIS_URL
 * — threw before a single assertion ran. That is not a failing test: the error
 * escapes module evaluation and kills the jest worker outright, which reports
 * as a suite that "failed to run" and takes the whole `pnpm test` exit code
 * with it.
 *
 * Nothing here needs the config. This guard reads AppModule's `imports`
 * metadata and the filesystem; it never instantiates a provider, which is the
 * "without booting anything" the docstring below describes. The real module is
 * replaced with a bare class rather than left to jest's automock, because an
 * automock introspects the real module to copy its shape and so would execute
 * the very file whose evaluation is the problem.
 *
 * The substitution is invisible to the assertions: they only ask whether each
 * module that owns a handler or a cron is in AppModule's imports, and
 * `AppConfigModule` owns neither.
 */
jest.mock('./config/config.module', () => ({
  AppConfigModule: class AppConfigModule {},
}));

import { AppModule } from './app.module';

/**
 * Every handler's module must be wired into AppModule.
 *
 * Bindings are created from the handlers DiscoveryService finds among
 * AppModule's providers. A handler in a module nobody imports is therefore
 * never discovered, no queue binding is made for its routing key, and the topic
 * exchange silently DISCARDS every message published to it — the message does
 * not fail, does not retry, and does not reach the dead-letter queue. There is
 * no trace of it anywhere.
 *
 * PaymentsModule was in exactly that state: `payment.refund_required` events
 * were published by the API, relayed to the exchange, and dropped. Refunds owed
 * to double-charged buyers went nowhere.
 *
 * Nothing else catches this. Each handler's own unit spec passes — the class is
 * correct in isolation; it is simply never reached. So the check is structural,
 * and it reads the filesystem rather than a hand-maintained list, because a
 * list is one more thing to forget to update alongside the module.
 */

const MODULES_DIR = join(__dirname, 'modules');

const HANDLER = '.handler.ts';
/**
 * A cron job is discovered the same way — by `ScheduleModule` scanning the
 * providers reachable from AppModule — and fails the same silent way: a sweep
 * in a module nobody imports never ticks, and nothing errors.
 */
const CRON = '.cron.ts';

/** The module class each handler (or cron) lives beside, e.g. `PaymentsModule`. */
function modulesOwning(
  suffix: string,
): { feature: string; moduleClass: string }[] {
  const owners: { feature: string; moduleClass: string }[] = [];

  for (const feature of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!feature.isDirectory()) continue;
    const dir = join(MODULES_DIR, feature.name);
    const files = readdirSync(dir);

    const hasOne = files.some(
      (f) => f.endsWith(suffix) && !f.endsWith('.spec.ts'),
    );
    if (!hasOne) continue;

    const moduleFile = files.find((f) => f.endsWith('.module.ts'));
    if (!moduleFile) continue;

    const source = readFileSync(join(dir, moduleFile), 'utf8');
    const declared = /export class (\w+Module)/.exec(source);
    if (declared)
      owners.push({ feature: feature.name, moduleClass: declared[1] });
  }
  return owners;
}

/** AppModule's `imports`, by class name, read without booting anything. */
function importedModuleNames(): string[] {
  const imported = (Reflect.getMetadata('imports', AppModule) ??
    []) as unknown[];
  return imported
    .map((m) => (typeof m === 'function' ? m.name : ''))
    .filter(Boolean);
}

describe('AppModule wiring', () => {
  const owners = modulesOwning(HANDLER);
  const cronOwners = modulesOwning(CRON);

  it('finds the feature modules that declare handlers', () => {
    // A guard on the guard: if the layout changes and this finds nothing, the
    // test below would pass vacuously and prove nothing.
    expect(owners.length).toBeGreaterThan(0);
  });

  it.each(owners)(
    'imports $moduleClass, so $feature handlers get a queue binding',
    ({ moduleClass }) => {
      expect(importedModuleNames()).toContain(moduleClass);
    },
  );

  it('finds the feature modules that run a cron job', () => {
    expect(cronOwners.length).toBeGreaterThan(0);
  });

  it.each(cronOwners)(
    'imports $moduleClass, so $feature cron jobs tick',
    ({ moduleClass }) => {
      expect(importedModuleNames()).toContain(moduleClass);
    },
  );
});

/**
 * The handler classes each feature declares, with the module beside them.
 *
 * `modulesOwning` above answers a different and insufficient question. It
 * checks that a module which OWNS a handler is imported by AppModule — and a
 * module can be imported while the handler inside it is not in its own
 * `providers`, which fails in exactly the same silent way. `ConsumerService`
 * discovers handlers through `DiscoveryService`, which walks PROVIDERS; a
 * handler class that no module provides is never instantiated, never
 * discovered, never bound, and the topic exchange discards every message for
 * its routing key with no failure, no retry and no dead-letter trace.
 *
 * This was found by mutation rather than by reading: deleting
 * `InvitationSentHandler` from `invitations.module.ts` left the whole suite
 * green at 56 files while `invitation.sent` went unbound.
 */
function handlerClassesByModule(): {
  feature: string;
  moduleClass: string;
  handlerClass: string;
  moduleSource: string;
}[] {
  const owned: {
    feature: string;
    moduleClass: string;
    handlerClass: string;
    moduleSource: string;
  }[] = [];

  for (const feature of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!feature.isDirectory()) continue;
    const dir = join(MODULES_DIR, feature.name);
    const files = readdirSync(dir);

    const moduleFile = files.find((f) => f.endsWith('.module.ts'));
    if (!moduleFile) continue;
    const moduleSource = readFileSync(join(dir, moduleFile), 'utf8');
    const declared = /export class (\w+Module)/.exec(moduleSource);
    if (!declared) continue;

    for (const file of files) {
      const isHandler = file.endsWith(HANDLER) || file.endsWith(CRON);
      if (!isHandler || file.endsWith('.spec.ts')) continue;
      const source = readFileSync(join(dir, file), 'utf8');
      for (const match of source.matchAll(/export class (\w+)/g)) {
        owned.push({
          feature: feature.name,
          moduleClass: declared[1],
          handlerClass: match[1],
          moduleSource,
        });
      }
    }
  }
  return owned;
}

describe('AppModule handler registration', () => {
  const handlers = handlerClassesByModule();

  it('finds the handler classes declared under modules/', () => {
    // A guard on the guard: nothing below proves anything if this is empty.
    expect(handlers.length).toBeGreaterThan(0);
  });

  it.each(handlers)(
    'provides $handlerClass in $moduleClass, so DiscoveryService can find it',
    ({ handlerClass, moduleSource }) => {
      // The PROVIDERS array specifically, not the file.
      //
      // Checking the whole source was the first attempt and it was vacuous: a
      // module that imports a handler and then does not provide it still
      // mentions the class on its `import` line, so the assertion passed with
      // the registration deleted — the very mutation this case exists for.
      expect(providersOf(moduleSource)).toContain(handlerClass);
    },
  );
});

/**
 * The class names inside a module's `providers: [ … ]`.
 *
 * Read from source because Nest's metadata is only on a class this file
 * deliberately never instantiates. The regex is deliberately narrow — it wants
 * the one array, not any array in the file — and `findings` below proves it
 * sees a real provider and misses a merely-imported one.
 */
function providersOf(moduleSource: string): string[] {
  const providers = /providers:\s*\[([^\]]*)\]/s.exec(moduleSource);
  if (!providers) return [];
  return providers[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

describe('providersOf', () => {
  // A guard on the guard above: if this stopped parsing the array, every
  // registration check would silently pass on an empty list.
  const sample = [
    'import { Thing } from "./thing";',
    'import { Unused } from "./unused";',
    '@Module({',
    '  imports: [OtherModule],',
    '  providers: [Thing],',
    '})',
    'export class SampleModule {}',
  ].join('\n');

  it('sees a class the module provides', () => {
    expect(providersOf(sample)).toContain('Thing');
  });

  it('does NOT see a class the module merely imports', () => {
    expect(providersOf(sample)).not.toContain('Unused');
  });

  it('does not mistake the imports array for the providers array', () => {
    expect(providersOf(sample)).not.toContain('OtherModule');
  });
});
